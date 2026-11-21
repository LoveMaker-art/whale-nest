'use strict';

// Adapt the original Voice page's socket frames to bounded HTTP requests.
globalThis.DshHttpVoiceSocket = class {
  constructor(base) {
    this.url = base+'voice-http/';
    this.readyState = 0;
    this.bufferedAmount = 0;
    this.queue = [];
    this.sequence = 0;
    this.after = 0;
    queueMicrotask(()=>{
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.();
    });
  }

  async request(path, data, retry=true) {
    const body = data === undefined ? undefined : JSON.stringify(data);
    for (let attempt=0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(()=>controller.abort(), 5000);
      try {
        const response = await fetch(this.url+path, {
          method:body === undefined ? 'GET' : 'POST',
          credentials:'same-origin',cache:'no-store',signal:controller.signal,
          ...(body === undefined ? {} : {headers:{'Content-Type':'application/json'},body}),
        });
        const value = await response.json();
        if (response.ok) return value;
        throw Object.assign(Error('Voice HTTP '+response.status), {status:response.status,frame:value.error});
      } catch(error) {
        if (!retry || attempt || this.readyState !== 1 || error.status && error.status < 500) throw error;
      } finally {clearTimeout(timer);}
    }
  }

  send(data) {
    if (this.readyState !== 1) return;
    const bytes = typeof data === 'string' ? 0 : data.byteLength;
    const frame = bytes ? {pcm:btoa(String.fromCharCode(...new Uint8Array(data)))} : JSON.parse(data);
    if (frame.type === 'start') {
      void this.start(frame);
      return;
    }
    if (this.bufferedAmount+bytes > 32768 || this.queue.length >= 48) {
      this.failed(Error('Voice HTTP upload backlog'));
      return;
    }
    this.bufferedAmount += bytes;
    this.queue.push({frame,bytes});
    queueMicrotask(()=>this.flush());
  }

  async start(frame) {
    try {
      const result = await this.request('start',{...frame,request_id:crypto.randomUUID()});
      this.session = result.session;
      if (this.readyState !== 1) {
        this.end();
        return;
      }
      void this.poll();
      void this.flush();
    } catch(error) {this.failed(error);}
  }

  async poll() {
    try {
      while (this.readyState === 1) {
        const result = await this.request(this.session+'/poll?after='+this.after);
        if (this.readyState !== 1) return;
        this.after = result.after;
        for (const frame of result.frames) {
          const {pcm,...metadata} = frame;
          this.onmessage?.({data:JSON.stringify(metadata)});
          if (pcm) this.onmessage?.({data:Uint8Array.from(atob(pcm),c=>c.charCodeAt(0)).buffer});
        }
        if (result.closed) return this.close();
      }
    } catch(error) {this.failed(error);}
  }

  async flush() {
    if (!this.session || this.sending || this.readyState !== 1 || !this.queue.length) return;
    this.sending = true;
    try {
      while (this.queue.length && this.readyState === 1) {
        // Four of the original 4 KiB PCM frames fit under the gateway limit.
        const batch = this.queue.splice(0,4);
        const sequence = ++this.sequence;
        const response = await this.request(this.session+'/frames',{sequence,frames:batch.map(item=>item.frame)});
        if (response.written !== sequence) throw Error('Voice HTTP receipt invalid');
        this.bufferedAmount -= batch.reduce((total,item)=>total+item.bytes,0);
      }
    } catch(error) {this.failed(error);}
    finally {this.sending=false;}
  }

  failed(error) {
    if (this.readyState !== 1) return;
    if (error.frame?.code) this.onmessage?.({data:JSON.stringify(error.frame)});
    else this.onerror?.();
    this.close(1006);
  }

  end() {
    if (!this.session) return;
    void fetch(this.url+this.session+'/end',{method:'POST',credentials:'same-origin',keepalive:true}).catch(()=>{});
  }

  close(code=1000) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.end();
    queueMicrotask(()=>this.onclose?.({code,reason:'',wasClean:code===1000}));
  }
};
