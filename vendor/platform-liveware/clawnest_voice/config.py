"""Configuration contains source names/paths, never credential values."""
import ast
import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit


STREAMING_ASR_PATH = '/v1/ali/audio/transcriptions/stream'


class ConfigError(ValueError):
    pass


def instance_settings(config_path, env_path, environ):
    """Same scalar-only Hermes config/.env mechanism as probe/e2e, no evaluation."""
    env = dict(environ)
    if env_path:
        for line in Path(env_path).read_text().splitlines():
            m = re.match(r'^(?:export\s+)?([A-Za-z_][\w]*)=(.*)$', line.strip())
            if m:
                env.setdefault(m[1], m[2].strip().strip('\"\''))
    values, stack = {}, []
    if config_path:
        for line in Path(config_path).read_text().splitlines():
            m = re.match(r'^( *)([A-Za-z_][\w-]*):(?:\s+(.*)|$)', line)
            if not m:
                continue
            indent, key, value = len(m[1]), m[2], m[3]
            while stack and stack[-1][0] >= indent:
                stack.pop()
            stack.append((indent, key))
            if value:
                value = value.split(' #', 1)[0].strip()
                if value[:1] in ('"', "'"):
                    try:
                        value = ast.literal_eval(value)
                    except (ValueError, SyntaxError):
                        raise ConfigError('invalid_instance_scalar') from None
                values['.'.join(k for _, k in stack)] = str(value)
    def resolve(value):
        return re.sub(r'\$\{([^}]+)\}|\$([A-Za-z_][\w]*)',
                      lambda m: env.get(m[1] or m[2], ''), value or '')
    return {k: resolve(v) for k, v in values.items()}, env


DEFAULT_VAD = dict(threshold=.018, playback_threshold=.065, attack_ms=260,
    playback_attack_ms=360, hangover_ms=650, min_speech_ms=400, preroll_ms=180,
    noise_floor_min=.002, noise_floor_max=.06, noise_ema_ms=2000,
    noise_multiplier=2.5, playback_noise_multiplier=3, exit_ratio=.65,
    calibration_ms=400, min_voiced_ratio=.55, barge_confirm_ms=450,
    candidate_release_ms=150, playback_guard_ms=400, duck_gain=.25, duck_ramp_ms=150,
    sensitivity_low=1.3, sensitivity_medium=1, sensitivity_high=.8)


@dataclass
class Config:
    port: int = 8897
    owner_env: str = 'CLAWCHAT_OWNER_USER_ID'
    instance_config: str = ''
    instance_env_file: str = ''
    hub_url_env: str = 'CLAWCHAT_VOICE_HUB_URL'
    hub_key_env: str = 'LLM_API_KEY'
    plugin_port_env: str = 'CLAWCHAT_VOICE_PLUGIN_PORT'
    plugin_secret_env: str = 'CLAWCHAT_VOICE_SECRET'
    plugin_secret_file: str = ''
    data_dir_env: str = 'CLAWCHAT_VOICE_DATA_DIR'
    friend_daily_seconds: float = 1200
    friend_session_seconds: float = 600
    owner_session_seconds: float = 1800
    connection_idle_seconds: float = 45
    idle_seconds: float = 60
    max_sessions: int = 2
    meter_interval: float = 1
    stt_model: str = 'fun-asr-flash'
    stt_mode: str = 'batch'
    stt_stream_model: str = 'qwen-audio-3.0-asr-flash-streaming'
    stt_stream_base_url: str = ''
    tts_mode: str = 'ws'
    tts_ws_url: str = ''
    tts_ws_pool: int = 2
    tts_ws_idle_s: float = 40
    tts_ws_cancel_s: float = 1
    tts_model: str = 'qwen-audio-3.0-tts-flash'
    tts_voice: str = 'longanfengyue'
    tts_sample_rate: int = 22050
    input_sample_rate: int = 16000
    max_utterance_seconds: float = 30
    max_audio_bytes: int = 2097152
    max_text_chars: int = 16384
    prosody_strategy: str = 'clauses'
    prosody_later_chars: int = 100
    prosody_smoothing: bool = True
    prosody_edge_ms: float = 50
    prosody_fade_ms: float = 8
    prosody_silence_rms: float = 80
    prosody_target_dbfs: float = -22
    prosody_gain_db: float = 0
    prosody_comma_pause_ms: float = 120
    prosody_sentence_pause_ms: float = 250
    sentence_chars: int = 100
    sentence_min_chars: int = 12
    tts_prefetch: int = 2
    tts_min_start_interval_ms: float = 400
    tts_retry_attempts: int = 4
    tts_retry_total_seconds: float = 8
    tts_retry_after_cap_seconds: float = 5
    tts_throttle_hedge_pause_seconds: float = 10
    stt_retry_attempts: int = 3
    stt_retry_total_seconds: float = 3
    tts_prepared: int = 12
    tts_straggler_seconds: float = 2
    tts_stall_seconds: float = 8
    sentence_first_min_chars: int = 6
    upload_mode: str = 'stream'
    pending_segments: int = 3
    max_segment_seconds: float = 30
    request_timeout: float = 30
    plugin_submit_retry_seconds: float = 6
    plugin_first_delta_seconds: float = 20
    plugin_events_gap_seconds: float = 20
    background_pause_seconds: float = 120
    diagnostic_drain_seconds: float = 3
    turn_timeout: float = 120
    write_timeout: float = 10
    audio_frame_bytes: int = 4096
    audio_realtime_factor: float = 1.3
    write_high_water: int = 8192
    control_reserve_bytes: int = 65536
    heartbeat_gap_seconds: float = 20
    heartbeat_log_interval: float = 15
    diagnostic_enabled: bool = True
    diagnostic_max_seconds: float = 10
    diagnostic_max_rate: int = 65536
    downstream_transport: str = 'ws'
    downstream_transport_phone: str = 'sse'
    playback_prebuffer_ms: float = 350
    playback_fade_ms: float = 3
    stt_min_chars: int = 2
    stt_fillers: list = field(default_factory=lambda: ['嗯', '啊', '呃', '哦', '唔', '额', 'uh', 'um', 'hmm'])
    vad: dict = field(default_factory=lambda: dict(DEFAULT_VAD))

    @classmethod
    def load(cls, path):
        try:
            values = json.loads(Path(path).read_text())
            # The first deployed release wrote this exact default profile.
            # Upgrade only that known profile in RAM; never rewrite private config
            # or silently repair custom invalid settings.
            legacy_vad = dict(threshold=.018, playback_threshold=.065, attack_ms=120,
                hangover_ms=650, min_speech_ms=200, preroll_ms=180)
            if isinstance(values, dict) and values.get('vad') == legacy_vad:
                values['vad'] = dict(DEFAULT_VAD)
            if isinstance(values, dict) and 'sentence_min_chars' not in values:
                values['sentence_min_chars'] = min(12, values.get('sentence_chars', 100))
            if isinstance(values, dict) and 'sentence_first_min_chars' not in values:
                values['sentence_first_min_chars'] = min(6, values.get('sentence_chars', 100))
            config = cls(**values)
            config.validate()
            return config
        except (OSError, ValueError, TypeError):
            raise ConfigError('invalid_gateway_config') from None

    def validate(self):
        if (self.prosody_strategy not in ('legacy', 'clauses') or
                type(self.prosody_smoothing) is not bool or
                type(self.prosody_later_chars) is not int or not 24 <= self.prosody_later_chars <= 160):
            raise ConfigError('invalid_prosody_config')
        for name, low, high in (
                ('prosody_edge_ms', 30, 60), ('prosody_fade_ms', 5, 10),
                ('prosody_silence_rms', 1, 184), ('prosody_target_dbfs', -30, -14),
                ('prosody_gain_db', 0, 6), ('prosody_comma_pause_ms', 0, 500),
                ('prosody_sentence_pause_ms', 0, 800)):
            value = getattr(self, name)
            if type(value) not in (int, float) or not low <= value <= high:
                raise ConfigError('invalid_' + name)
        for name in ('port', 'max_sessions', 'max_audio_bytes', 'max_text_chars',
                     'sentence_chars', 'sentence_min_chars', 'sentence_first_min_chars', 'tts_prefetch', 'tts_ws_pool', 'tts_prepared', 'tts_retry_attempts', 'stt_retry_attempts', 'pending_segments', 'tts_sample_rate', 'input_sample_rate', 'stt_min_chars',
                     'audio_frame_bytes', 'write_high_water', 'control_reserve_bytes', 'diagnostic_max_rate'):
            value = getattr(self, name)
            if type(value) is not int or value <= 0:
                raise ConfigError('invalid_' + name)
        for name in ('friend_daily_seconds', 'friend_session_seconds', 'owner_session_seconds',
                     'idle_seconds', 'connection_idle_seconds', 'meter_interval', 'tts_ws_idle_s', 'tts_ws_cancel_s', 'max_utterance_seconds',
                     'max_segment_seconds', 'tts_straggler_seconds', 'tts_stall_seconds', 'request_timeout', 'plugin_submit_retry_seconds',
                     'turn_timeout', 'plugin_first_delta_seconds', 'plugin_events_gap_seconds', 'background_pause_seconds', 'diagnostic_drain_seconds', 'write_timeout', 'playback_prebuffer_ms', 'playback_fade_ms',
                     'audio_realtime_factor', 'heartbeat_gap_seconds', 'heartbeat_log_interval', 'diagnostic_max_seconds'):
            value = getattr(self, name)
            if type(value) not in (int, float) or not 0 < value < 1e8:
                raise ConfigError('invalid_' + name)
        for name, high in (('tts_min_start_interval_ms', 5000), ('tts_retry_total_seconds', 30),
                           ('tts_retry_after_cap_seconds', 30), ('tts_throttle_hedge_pause_seconds', 120),
                           ('stt_retry_total_seconds', 30)):
            value = getattr(self, name)
            if type(value) not in (int, float) or not 0 <= value <= high:
                raise ConfigError('invalid_' + name)
        if not 1 <= self.tts_retry_attempts <= 6 or not 1 <= self.stt_retry_attempts <= 4:
            raise ConfigError('invalid_retry_attempts')
        if (self.stt_mode not in ('stream', 'batch') or not isinstance(self.stt_stream_model, str)
                or not self.stt_stream_model.strip() or len(self.stt_stream_model) > 256
                or any(ord(c) < 32 for c in self.stt_stream_model)):
            raise ConfigError('invalid_stt_config')
        self.streaming_base_url()
        self.tts_websocket_base_url()
        if (self.tts_ws_pool > 4 or self.tts_mode not in ('http', 'ws') or self.tts_ws_idle_s >= 45
                or self.tts_ws_cancel_s > 5 or self.tts_sample_rate not in (8000, 16000, 22050, 24000, 44100, 48000)
                or not isinstance(self.tts_model, str) or not self.tts_model.strip() or len(self.tts_model) > 256
                or any(ord(c) < 32 or ord(c) == 127 for c in self.tts_model)
                or not isinstance(self.tts_voice, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', self.tts_voice)):
            raise ConfigError('invalid_tts_config')
        if self.port >= 65536:
            raise ConfigError('invalid_port')
        if (self.audio_frame_bytes > 4096 or self.audio_frame_bytes % 2 or
            not 1.3 <= self.audio_realtime_factor <= 2 or self.tts_prefetch > 3 or
            self.upload_mode not in ('stream', 'batch') or self.tts_prepared > 24 or
            self.tts_prepared < self.tts_prefetch or self.sentence_first_min_chars > self.sentence_chars or
            self.sentence_min_chars > self.sentence_chars or self.write_high_water > 65536 or
            self.control_reserve_bytes > 262144 or self.diagnostic_max_seconds > 10 or
            self.diagnostic_max_rate > 65536 or type(self.diagnostic_enabled) is not bool or
            self.downstream_transport not in ('ws', 'sse') or self.downstream_transport_phone != 'sse' or
            self.diagnostic_drain_seconds > 10 or self.background_pause_seconds > 600 or
            self.plugin_events_gap_seconds > 60 or self.plugin_first_delta_seconds > 60):
            raise ConfigError('invalid_downstream_config')
        if self.plugin_secret_file and self.plugin_secret_env:
            raise ConfigError('choose_one_plugin_secret_source')
        if self.plugin_secret_file and not Path(self.plugin_secret_file).is_absolute():
            raise ConfigError('absolute_secret_file_required')
        if not isinstance(self.vad, dict) or set(self.vad) - set(DEFAULT_VAD):
            raise ConfigError('invalid_vad')
        # Older configs inherit the new safety defaults; explicit invalid keys fail closed.
        self.vad = {**DEFAULT_VAD, **self.vad}
        if any(type(v) not in (float, int) or not 0 < v < 10000 for v in self.vad.values()):
            raise ConfigError('invalid_vad')
        v = self.vad
        if (v['attack_ms'] < 250 or v['playback_attack_ms'] < 350 or v['barge_confirm_ms'] < 450 or
            v['barge_confirm_ms'] < v['playback_attack_ms'] or v['min_speech_ms'] < 400 or
            v['noise_floor_min'] > v['noise_floor_max'] or v['noise_floor_max'] >= 1 or
            v['threshold'] >= 1 or v['playback_threshold'] >= 1 or
            not 0 < v['exit_ratio'] < 1 or not 0 < v['min_voiced_ratio'] <= 1 or
            not 0 < v['duck_gain'] <= 1 or not 0 < self.playback_prebuffer_ms <= 2000 or
            not 0 < self.playback_fade_ms <= 20):
            raise ConfigError('invalid_audio_config')
        if (not isinstance(self.stt_fillers, list) or len(self.stt_fillers) > 128 or
            any(not isinstance(x, str) or not x.strip() or len(x) > 64 for x in self.stt_fillers)):
            raise ConfigError('invalid_stt_fillers')

    def tts_websocket_base_url(self, hub_base=None):
        # Reuse the ASR credential-destination checks without mutating this config.
        from dataclasses import replace
        if not isinstance(self.tts_ws_url, str):
            raise ConfigError('invalid_tts_ws_url')
        return replace(self, stt_stream_base_url=self.tts_ws_url or self.stt_stream_base_url).streaming_base_url(hub_base)

    def streaming_base_url(self, hub_base=None):
        """Validate the optional credential destination; normalize WS schemes for transport."""
        base = self.stt_stream_base_url
        if not isinstance(base, str):
            raise ConfigError('invalid_stt_stream_base_url')
        if not base:
            return ''
        try:
            url = urlsplit(base)
            if (url.scheme not in ('http', 'https', 'ws', 'wss') or not url.hostname
                    or url.username is not None or url.password is not None
                    or url.query or url.fragment or '\\' in base
                    or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in base)
                    or (url.port is not None and not 0 < url.port < 65536)):
                raise ValueError
            if (hub_base is not None and url.hostname != urlsplit(hub_base).hostname
                    and not url.hostname.endswith('.svc.cluster.local')):
                raise ValueError
        except ValueError:
            raise ConfigError('invalid_stt_stream_base_url') from None
        scheme = {'ws': 'http', 'wss': 'https'}.get(url.scheme, url.scheme)
        return urlunsplit(url._replace(scheme=scheme)).rstrip('/').removesuffix('/v1')

    def runtime(self, environ=None):
        values, env = instance_settings(self.instance_config, self.instance_env_file,
                                        os.environ if environ is None else environ)
        owner = env.get(self.owner_env) or values.get('owner_user_id', '')
        provider_url = values.get('providers.clawling.api', '')
        provider_key = values.get('providers.clawling.api_key', '')
        if provider_url or provider_key:
            # The assigned endpoint and key belong together. Unrelated model
            # environment variables must not replace either half of this pair.
            if not provider_url or not provider_key:
                raise ConfigError('missing_instance_provider_configuration')
            hub_url, hub_key = provider_url, provider_key
        else:
            hub_url = env.get(self.hub_url_env, '')
            hub_key = env.get('CLAWLING_API_KEY') or env.get(self.hub_key_env, '')
        data_dir = env.get(self.data_dir_env) or str(Path.home() / '.local/share/clawchat-voice')
        try:
            port = int(env.get(self.plugin_port_env, '18991'))
        except ValueError:
            raise ConfigError('invalid_plugin_port') from None
        if not owner or not hub_url or not hub_key or not 0 < port < 65536:
            raise ConfigError('missing_runtime_configuration')
        if not Path(data_dir).is_absolute():
            raise ConfigError('absolute_data_dir_required')
        # Data belongs outside the entire project, not just outside liveware/.
        project = Path(__file__).resolve().parent.parent
        if Path(data_dir).resolve().is_relative_to(project):
            raise ConfigError('data_dir_must_be_outside_repo')
        return owner, hub_url, hub_key, port, Path(data_dir)

    def plugin_secret(self):
        try:
            value = (Path(self.plugin_secret_file).read_text().strip() if self.plugin_secret_file
                     else os.environ.get(self.plugin_secret_env, ''))
        except OSError:
            raise ConfigError('plugin_secret_unavailable') from None
        if len(value.encode()) < 32 or '\r' in value or '\n' in value:
            raise ConfigError('plugin_secret_unavailable')
        return value
