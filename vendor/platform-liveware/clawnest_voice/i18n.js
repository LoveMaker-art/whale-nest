/* UI copy only. Transcript and model output never pass through this catalog. */
(function(root) {
  'use strict';
  const locales = ['en', 'zh-TW', 'ja', 'es', 'ko'];
  // Simplified Chinese source (aliases separated by ~), then the five translations.
  const rows = `
语音通话|Voice call|語音通話|音声通話|Llamada de voz|음성 통화
通话对象|Call participant|通話對象|通話相手|Participante|통화 상대
通话设置|Call settings|通話設定|通話設定|Ajustes de llamada|통화 설정
通话控制|Call controls|通話控制|通話操作|Controles de llamada|통화 제어
通话时长|Call duration|通話時長|通話時間|Duración de la llamada|통화 시간
通话|Call|通話|通話|Llamada|통화
拨打|Call|撥打|発信|Llamar|전화 걸기
关闭|Close|關閉|閉じる|Cerrar|닫기
静音|Mute|靜音|ミュート|Silenciar|음소거
取消静音|Unmute|取消靜音|ミュート解除|Activar micrófono|음소거 해제
麦克风已静音|Microphone muted|麥克風已靜音|マイクはミュート中|Micrófono silenciado|마이크가 음소거되었습니다
字幕|Captions|字幕|字幕|Subtítulos|자막
查看字幕|View captions|查看字幕|字幕を見る|Ver subtítulos|자막 보기
这次通话的字幕|Call captions|這次通話的字幕|今回の通話の字幕|Subtítulos de esta llamada|이번 통화 자막
开口打断|Interrupt by speaking|開口打斷|話して割り込む|Interrumpir al hablar|말해서 끼어들기
{agent}在说话时，你一开口，它就先停下来听你。|When you speak, {agent} stops talking and listens.|{agent}在說話時，你一開口，它就先停下來聽你。|話し始めると、{agent}は返答を止めて聞きます。|Al hablar, {agent} deja de hablar y te escucha.|말을 시작하면 {agent}의 답변이 멈추고 듣습니다.
{agent}会先把这句话说完，再听你说。|{agent} finishes speaking before listening.|{agent}會先把這句話說完，再聽你說。|{agent}は返答を終えてから話を聞きます。|{agent} termina de hablar antes de escucharte.|{agent}의 답변이 끝난 뒤 말을 듣습니다.
对方|Your companion|對方|相手|Tu acompañante|통화 상대
多容易打断|Interruption sensitivity|多容易打斷|割り込みの感度|Sensibilidad de interrupción|끼어들기 감도
不易打断|Harder to interrupt|不易打斷|割り込みにくい|Más difícil|끼어들기 어려움
更易打断|Easier to interrupt|更易打斷|割り込みやすい|Más fácil|끼어들기 쉬움
让对方更容易听到你|Help your companion hear you|讓對方更容易聽到你|相手が聞き取りやすくする|Ayuda a tu acompañante a oírte|상대가 내 말을 더 잘 듣게 하기
让{agent}更容易听到你|Help {agent} hear you|讓{agent}更容易聽到你|{agent}が聞き取りやすくする|Ayuda a {agent} a oírte|{agent}이 내 말을 더 잘 듣게 하기
周围声音常被当成你在说话，就往左调。说得轻容易漏掉，就往右调。下一句话生效。|Move left if background noise is picked up as speech. Move right if quiet speech is missed. Applies to your next utterance.|周圍聲音常被當成你在說話，就往左調。說得輕容易漏掉，就往右調。下一句話生效。|雑音を声と誤認する場合は左へ、小声が拾われにくい場合は右へ。次の発話から適用されます。|Desliza a la izquierda si capta ruido como voz, o a la derecha si no detecta tu voz baja. Se aplica a tu siguiente frase.|주변 소리가 말로 인식되면 왼쪽으로, 작은 목소리를 놓치면 오른쪽으로 조절하세요. 다음 발화부터 적용됩니다.
少收环境声|Less background noise|少收環境聲|雑音を抑える|Menos ruido|주변 소리 줄이기
更容易听见轻声|Pick up quieter speech|更容易聽見輕聲|小声を拾う|Captar voces bajas|작은 목소리 잘 듣기
开始通话后可查看音量|See the level once the call starts|開始通話後可查看音量|通話開始後に音量を確認できます|Consulta el nivel al iniciar la llamada|통화가 시작되면 음량을 확인할 수 있습니다
字幕出现时机|Caption timing|字幕出現時機|字幕の表示タイミング|Cuándo mostrar subtítulos|자막 표시 시점
跟着声音|With audio|跟著聲音|音声に合わせる|Con el audio|음성에 맞춰
先看文字|Text first|先看文字|テキストを先に表示|Texto primero|텍스트 먼저
下一句回复生效。|Applies to the next reply.|下一句回覆生效。|次の返答から適用されます。|Se aplica a la próxima respuesta.|다음 답변부터 적용됩니다.
通话遇到问题|Call troubleshooting|通話遇到問題|通話のトラブル|Problemas de llamada|통화 문제 해결
声音断续时|Choppy audio|聲音斷續時|音声が途切れる場合|Audio entrecortado|음성이 끊길 때
「播放更稳」会先存一小段声音再播放，首句可能稍晚听到。下一条回复生效。|Smoother playback buffers a little audio, so you may hear the first sentence later. Applies to the next reply.|「播放更穩」會先存一小段聲音再播放，首句可能稍晚聽到。下一條回覆生效。|安定再生では音声を少し貯めるため、最初の文が遅れることがあります。次の返答から適用されます。|La reproducción más fluida almacena audio, por lo que la primera frase puede tardar. Se aplica a la próxima respuesta.|안정적인 재생은 음성을 잠시 모았다가 재생하여 첫 문장이 늦어질 수 있습니다. 다음 답변부터 적용됩니다.
最快播放|Fastest playback|最快播放|最速再生|Reproducción más rápida|가장 빠른 재생
标准（推荐）|Standard (recommended)|標準（推薦）|標準（推奨）|Estándar (recomendado)|표준(권장)
播放更稳 · 1 秒|Smoother playback · 1 s|播放更穩 · 1 秒|安定再生 · 1 秒|Más fluida · 1 s|안정적인 재생 · 1초
播放更稳 · 1.5 秒|Smoother playback · 1.5 s|播放更穩 · 1.5 秒|安定再生 · 1.5 秒|Más fluida · 1,5 s|안정적인 재생 · 1.5초
播放更稳 · 2.5 秒|Smoother playback · 2.5 s|播放更穩 · 2.5 秒|安定再生 · 2.5 秒|Más fluida · 2,5 s|안정적인 재생 · 2.5초
故障信息|Troubleshooting info|故障資訊|トラブル情報|Información del problema|문제 해결 정보
复制故障信息|Copy troubleshooting info|複製故障資訊|トラブル情報をコピー|Copiar información del problema|문제 해결 정보 복사
已复制故障信息|Troubleshooting info copied|已複製故障資訊|トラブル情報をコピーしました|Información copiada|문제 해결 정보가 복사되었습니다
可手动复制下方的故障信息|Copy the troubleshooting info below|可手動複製下方的故障資訊|下のトラブル情報をコピーしてください|Puedes copiar la información de abajo|아래 문제 해결 정보를 복사하세요
语音聊天~语音聊天 · ClawNest~ClawNest · 语音|Voice · ClawNest|語音聊天 · ClawNest|音声通話 · ClawNest|Voz · ClawNest|음성 대화 · ClawNest
/ 语音|/ Voice|/ 語音|/ 音声|/ Voz|/ 음성
设置|Settings|設定|設定|Ajustes|설정
这次对话|This conversation|這次對話|今回の会話|Esta conversación|이번 대화
对话文字|Conversation transcript|對話文字|会話のテキスト|Transcripción|대화 내용
聊天控制|Call controls|聊天控制|通話操作|Controles de llamada|통화 제어
通知|Notification|通知|通知|Aviso|알림
通知详情|Notification details|通知詳情|通知の詳細|Detalles del aviso|알림 세부 정보
关闭通知|Dismiss notification|關閉通知|通知を閉じる|Cerrar aviso|알림 닫기
关闭设置|Close settings|關閉設定|設定を閉じる|Cerrar ajustes|설정 닫기
嗨，开口聊聊吧|Hi, let's talk|嗨，開口聊聊吧|こんにちは、話しましょう|Hola, hablemos|안녕하세요, 이야기해요
想到什么，就聊什么。|Talk about whatever is on your mind.|想到什麼，就聊什麼。|思いついたことを話してください。|Habla de lo que quieras.|생각나는 대로 이야기하세요.
首次开始时，请允许使用麦克风。|Allow microphone access when you start.|首次開始時，請允許使用麥克風。|開始時にマイクの使用を許可してください。|Permite el micrófono al empezar.|처음 시작할 때 마이크를 허용하세요.
结束后，麦克风就会关闭。|The microphone turns off when you end the call.|結束後，麥克風就會關閉。|通話終了時にマイクはオフになります。|El micrófono se apaga al terminar.|통화를 끝내면 마이크가 꺼집니다.
按自己的习惯|Make it yours|按自己的習慣|お好みに合わせて|A tu gusto|취향에 맞게
基础|Basics|基本|基本|General|기본
点击绿色电话按钮后，才会开启麦克风并连接。|Tap the green phone button to enable the microphone and connect.|點擊綠色電話按鈕後，才會開啟麥克風並連線。|緑の電話ボタンでマイクを有効にして接続します。|Pulsa el teléfono verde para activar el micrófono y conectar.|초록색 전화 버튼을 누르면 마이크가 켜지고 연결됩니다.
麦克风与打断|Microphone and interruptions|麥克風與打斷|マイクと割り込み|Micrófono e interrupciones|마이크 및 끼어들기
麦克风灵敏度|Microphone sensitivity|麥克風靈敏度|マイク感度|Sensibilidad del micrófono|마이크 감도
环境吵就调低，声音小就调高。下一句话生效。|Lower it for noise, raise it for a quiet voice. Applies to your next utterance.|環境吵就調低，聲音小就調高。下一句話生效。|騒音時は低く、小声なら高く。次の発話から適用されます。|Bájala si hay ruido, súbela si hablas bajo. Se aplica a la próxima frase.|주변이 시끄러우면 낮추고 목소리가 작으면 높이세요. 다음 발화부터 적용됩니다.
麦克风实时音量|Live microphone level|麥克風即時音量|マイクの現在の音量|Nivel del micrófono|실시간 마이크 음량
允许中途打断|Allow interruptions|允許中途打斷|割り込みを許可|Permitir interrupciones|끼어들기 허용
已开启打断：回复时也能听你说。|Interruptions on: you can speak during replies.|已開啟打斷：回覆時也能聽你說。|割り込みオン：応答中も話せます。|Interrupciones activadas: puedes hablar durante las respuestas.|끼어들기 켜짐: 답변 중에도 말할 수 있습니다.
已关闭打断：回复说完才会听你说|Interruptions off: wait until the reply ends.|已關閉打斷：回覆說完才會聽你說|割り込みオフ：応答の終了後に話してください。|Interrupciones desactivadas: espera a que termine la respuesta.|끼어들기 꺼짐: 답변이 끝난 후 말하세요.
打断灵敏度|Interruption sensitivity|打斷靈敏度|割り込み感度|Sensibilidad de interrupción|끼어들기 감도
扬声器回声多时调低打断灵敏度；戴耳机可减少回声。|Lower interruption sensitivity for speaker echo. Headphones reduce echo.|揚聲器回音多時調低打斷靈敏度；戴耳機可減少回音。|スピーカーの反響が多い場合は感度を下げてください。イヤホンで反響を減らせます。|Baja la sensibilidad si hay eco. Los auriculares reducen el eco.|스피커 울림이 크면 감도를 낮추세요. 이어폰을 쓰면 울림이 줄어듭니다.
显示|Display|顯示|表示|Pantalla|표시
文字立即显示|Show text immediately|文字立即顯示|テキストをすぐ表示|Mostrar texto al instante|텍스트 즉시 표시
文字到达就显示，语音照常播放。关闭后随语音逐句显示，下一轮生效。|Show text as it arrives while audio plays. Turn off to reveal it with speech, starting next turn.|文字到達就顯示，語音照常播放。關閉後隨語音逐句顯示，下一輪生效。|音声再生中も届いたテキストを表示。オフにすると次の応答から音声に合わせて表示します。|Muestra el texto al llegar mientras suena el audio. Desactívalo para sincronizarlo con la voz desde el próximo turno.|음성 재생 중 도착한 텍스트를 바로 표시합니다. 끄면 다음 답변부터 음성에 맞춰 표시합니다.
调试|Debug|偵錯|デバッグ|Depuración|디버그
调试模式|Debug mode|偵錯模式|デバッグモード|Modo de depuración|디버그 모드
只改变本页信息的显示|Only changes what this page displays|只改變本頁資訊的顯示|このページの情報表示のみ変更|Solo cambia la información de esta página|이 페이지의 정보 표시만 변경합니다
播放前稍等一下~语音预缓冲|Playback buffer|語音預緩衝|再生バッファー|Búfer de reproducción|재생 버퍼
先备好一小段声音。下一条回复生效。|Buffer a little audio before playback. Applies to the next reply.|先備好一小段聲音。下一條回覆生效。|再生前に音声を少し蓄えます。次の応答から適用。|Prepara un poco de audio antes de reproducir. Se aplica a la próxima respuesta.|재생 전에 음성을 조금 준비합니다. 다음 답변부터 적용됩니다.
下一条回复生效|Applies to the next reply|下一條回覆生效|次の応答から適用|Se aplica a la próxima respuesta|다음 답변부터 적용
关闭（原有播放）|Off (original playback)|關閉（原有播放）|オフ（従来の再生）|Desactivado (reproducción original)|끄기 (기존 재생)
1 秒|1 second|1 秒|1 秒|1 segundo|1초
1.5 秒（默认）|1.5 seconds (default)|1.5 秒（預設）|1.5 秒（既定）|1,5 segundos (predeterminado)|1.5초 (기본)
0.6 秒（默认）|0.6 seconds (default)|0.6 秒（預設）|0.6 秒（既定）|0,6 segundos (predeterminado)|0.6초 (기본)
1.5 秒|1.5 seconds|1.5 秒|1.5 秒|1,5 segundos|1.5초
2.5 秒|2.5 seconds|2.5 秒|2.5 秒|2,5 segundos|2.5초
语音调试|Voice debug|語音偵錯|音声デバッグ|Depuración de voz|음성 디버그
完成一轮后显示|Shown after a turn|完成一輪後顯示|応答後に表示|Se muestra tras un turno|대화 한 차례 후 표시
诊断|Diagnostics|診斷|診断|Diagnóstico|진단
诊断记录|Diagnostic log|診斷記錄|診断ログ|Registro de diagnóstico|진단 기록
复制最近记录|Copy recent log|複製最近記錄|最近のログをコピー|Copiar registro reciente|최근 기록 복사
版本|Version|版本|バージョン|Versión|버전
下行传输:|Downstream:|下行傳輸：|受信方式：|Recepción:|수신 방식:
SSE（默认）|SSE (default)|SSE（預設）|SSE（既定）|SSE (predeterminado)|SSE (기본)
WS（诊断）|WS (diagnostic)|WS（診斷）|WS（診断）|WS (diagnóstico)|WS (진단)
仅发送合成静音，不播放、不录音。每项 10 秒；测试时暂停语音输入。|Synthetic silence only; no playback or recording. Each test lasts 10 seconds and pauses voice input.|僅傳送合成靜音，不播放、不錄音。每項 10 秒；測試時暫停語音輸入。|合成無音のみ送信。再生・録音なし。各テスト10秒、音声入力は一時停止します。|Solo silencio sintético, sin reproducción ni grabación. Cada prueba dura 10 segundos y pausa la entrada de voz.|합성 무음만 전송하며 재생하거나 녹음하지 않습니다. 각 테스트는 10초이며 음성 입력이 일시 정지됩니다.
下行|Download|下行|受信|Descarga|수신
上行|Upload|上行|送信|Subida|송신
双向|Both directions|雙向|双方向|Ambas direcciones|양방향
WS + SSE 对照|Compare WS + SSE|WS + SSE 對照|WS + SSE 比較|Comparar WS + SSE|WS + SSE 비교
帧|Frame|影格|フレーム|Trama|프레임
全部 1/4/16/64 KB|All: 1/4/16/64 KB|全部 1/4/16/64 KB|すべて 1/4/16/64 KB|Todas: 1/4/16/64 KB|전체 1/4/16/64 KB
节奏|Pattern|節奏|パターン|Patrón|패턴
稳态 + 突发|Steady + burst|穩態 + 突發|一定 + バースト|Constante + ráfagas|일정 + 버스트
44 KB/s 稳态|44 KB/s steady|44 KB/s 穩態|44 KB/s 一定|44 KB/s constante|44 KB/s 일정
200 KB/100 ms 突发|200 KB/100 ms burst|200 KB/100 ms 突發|200 KB/100 ms バースト|200 KB/100 ms ráfagas|200 KB/100 ms 버스트
下行压力测试|Download stress test|下行壓力測試|受信負荷テスト|Prueba de descarga|수신 부하 테스트
上行压力测试|Upload stress test|上行壓力測試|送信負荷テスト|Prueba de subida|송신 부하 테스트
双向压力测试|Bidirectional stress test|雙向壓力測試|双方向負荷テスト|Prueba bidireccional|양방향 부하 테스트
停止|Stop|停止|停止|Detener|중지
开启麦克风连接后可测试；测试期间麦克风数据不会上传。|Connect the microphone to test; microphone audio is not uploaded during tests.|開啟麥克風連線後可測試；測試期間不會上傳麥克風資料。|マイク接続後にテスト可能。テスト中はマイク音声を送信しません。|Conecta el micrófono para probar; no se sube su audio durante las pruebas.|마이크 연결 후 테스트할 수 있습니다. 테스트 중에는 마이크 음성을 업로드하지 않습니다.
模式|Mode|模式|モード|Modo|모드
传输|Transport|傳輸|通信|Transporte|전송
帧/节奏|Frame/pattern|影格/節奏|フレーム/パターン|Trama/patrón|프레임/패턴
收帧|Frames received|收到影格|受信フレーム|Tramas recibidas|수신 프레임
缺/乱/重|Missing/order/duplicates|缺/亂/重|欠落/順序/重複|Faltan/orden/duplicadas|누락/순서/중복
间隔|Gap|間隔|間隔|Intervalo|간격
抖动 ms|Jitter ms|抖動 ms|ジッター ms|Variación ms|지터 ms
上行帧|Frames sent|上行影格|送信フレーム|Tramas enviadas|송신 프레임
KB/缺|KB/missing|KB/缺|KB/欠落|KB/faltan|KB/누락
结果|Result|結果|結果|Resultado|결과
关闭码/原因|Close code/reason|關閉碼/原因|終了コード/理由|Código/motivo|종료 코드/사유
KB 为 1024 字节；稳态为 44,100 B/s，上行为 32,768 B/s。抖动排除发送节奏，SSE 另有约 33% base64 开销。缺失或断线请截图；结果也会记录到服务端 UTC 日志。|KB means 1024 bytes. Steady: 44,100 B/s; upload: 32,768 B/s. Jitter excludes sending cadence; SSE adds about 33% base64 overhead. Capture missing data or disconnects; results also enter the server UTC log.|KB 為 1024 位元組；穩態 44,100 B/s，上行 32,768 B/s。抖動排除傳送節奏，SSE 另有約 33% base64 額外負擔。缺失或斷線請截圖；結果也會記錄到伺服器 UTC 日誌。|KB は1024バイト。一定送信は44,100 B/s、上りは32,768 B/s。ジッターは送信間隔を除外し、SSE は base64 で約33%増加。欠落や切断は画面を保存してください。結果はサーバーの UTC ログにも記録します。|KB son 1024 bytes. Constante: 44.100 B/s; subida: 32.768 B/s. La variación excluye el ritmo de envío; SSE añade un 33% por base64. Captura pérdidas o cortes; los resultados se guardan en el registro UTC del servidor.|KB는 1024바이트입니다. 일정 전송은 44,100 B/s, 송신은 32,768 B/s입니다. 지터는 전송 간격을 제외하며 SSE의 base64 오버헤드는 약 33%입니다. 누락이나 끊김은 화면을 저장하세요. 결과는 서버 UTC 로그에도 기록됩니다.
说吧，我在听。|Go ahead, I'm listening.|說吧，我在聽。|どうぞ、聞いています。|Adelante, te escucho.|말씀하세요, 듣고 있어요.
像聊天一样开口。想换个话题，直接打断就好。|Speak naturally. Interrupt any time to change the topic.|像聊天一樣開口。想換個話題，直接打斷就好。|自然に話してください。話題を変えたいときは割り込めます。|Habla con naturalidad. Interrumpe cuando quieras cambiar de tema.|편하게 이야기하세요. 주제를 바꾸고 싶으면 끼어들어도 됩니다.
实时字幕|Live captions|即時字幕|リアルタイム字幕|Subtítulos en directo|실시간 자막
你说|You said|你說|あなたの発言|Has dicho|내가 한 말
对话开始后，文字会出现在这里。|Your conversation will appear here.|對話開始後，文字會出現在這裡。|会話が始まるとここに表示されます。|La conversación aparecerá aquí.|대화를 시작하면 여기에 표시됩니다.
本次 00:00|This call 00:00|本次 00:00|今回 00:00|Esta llamada 00:00|이번 통화 00:00
剩余时长连接后显示|Remaining time appears after connecting|剩餘時長連線後顯示|接続後に残り時間を表示|El tiempo restante aparece al conectar|연결 후 남은 시간이 표시됩니다
开启麦克风~再次开启麦克风|Enable microphone|開啟麥克風|マイクを有効にする|Activar micrófono|마이크 켜기
结束对话~结束|End call|結束對話|通話終了|Finalizar llamada|통화 종료
中|Medium|中|中|Media|중간
回复文字|Reply text|回覆文字|応答テキスト|Texto de respuesta|답변 텍스트
随语音逐句显示|Reveal with speech|隨語音逐句顯示|音声に合わせて表示|Mostrar con la voz|음성에 맞춰 표시
立即显示全部文字（调试）|Show all text immediately (debug)|立即顯示全部文字（偵錯）|全文をすぐ表示（デバッグ）|Mostrar todo al instante (depuración)|모든 텍스트 즉시 표시 (디버그)
不保存原始录音。已确认播放的完整句段会留在你和 Agent 的聊天里。|Raw recordings are not saved. Fully played sentences remain in your chat with the Agent.|不儲存原始錄音。已確認播放的完整句段會留在你和 Agent 的聊天裡。|生の録音は保存しません。再生確認済みの文は Agent とのチャットに残ります。|No se guardan grabaciones. Las frases reproducidas completas quedan en tu chat con el Agent.|원본 녹음은 저장하지 않습니다. 재생이 확인된 문장은 Agent와의 채팅에 남습니다.
`.trim().split('\n');
  rows.push(...`
点击拨打|Tap to call|點擊撥打|タップして通話|Pulsa para llamar|눌러서 통화
开始通话~开始聊天|Start call|開始通話|通話を開始|Iniciar llamada|통화 시작
挂断|Hang up|掛斷|切断|Colgar|전화 끊기
准备好就开始|Start when you're ready|準備好就開始|準備ができたら開始|Empieza cuando quieras|준비되면 시작하세요
请在安静的地方开启麦克风|Enable the microphone somewhere quiet|請在安靜的地方開啟麥克風|静かな場所でマイクを有効にしてください|Activa el micrófono en un lugar tranquilo|조용한 곳에서 마이크를 켜세요
点一下，开启麦克风。|Tap to enable the microphone.|點一下，開啟麥克風。|タップしてマイクを有効にします。|Pulsa para activar el micrófono.|눌러서 마이크를 켜세요.
尚未连接|Not connected|尚未連線|未接続|Sin conectar|연결 안 됨
已连接|Connected|已連線|接続済み|Conectado|연결됨
已断开~连接已断开|Disconnected|已斷線|切断されました|Desconectado|연결 끊김
已结束~对话已结束|Call ended|已結束|通話が終了しました|Llamada finalizada|통화 종료됨
已结束，尚未连接|Call ended; not connected|已結束，尚未連線|通話終了、未接続|Llamada finalizada; sin conectar|통화 종료, 연결 안 됨
正在连接~连接中|Connecting|連線中|接続中|Conectando|연결 중
正在建立语音连接|Connecting voice call|正在建立語音連線|音声通話に接続中|Conectando la llamada|음성 통화 연결 중
正在重新连接|Reconnecting|正在重新連線|再接続中|Reconectando|다시 연결 중
正在准备麦克风|Preparing microphone|正在準備麥克風|マイクを準備中|Preparando micrófono|마이크 준비 중
正在开启麦克风，请保持页面在前台|Enabling microphone. Keep this page in the foreground.|正在開啟麥克風，請保持頁面在前景|マイクを有効にしています。この画面を開いたままにしてください。|Activando micrófono. Mantén esta página en primer plano.|마이크를 켜고 있습니다. 이 페이지를 열어 두세요.
取消准备|Cancel setup|取消準備|準備をキャンセル|Cancelar preparación|준비 취소
正在释放麦克风，请稍候|Releasing microphone. Please wait.|正在釋放麥克風，請稍候|マイクを解放中です。お待ちください。|Liberando micrófono. Espera.|마이크를 해제 중입니다. 잠시 기다리세요.
正在听你说|Listening|正在聽你說|聞いています|Escuchando|듣고 있어요
正在听，文字可能调整|Listening; transcript may change|正在聽，文字可能調整|聞いています。文字は変更される場合があります|Escuchando; el texto puede cambiar|듣는 중이며 텍스트가 바뀔 수 있습니다
正在想|Thinking|正在想|考えています|Pensando|생각 중
正在说|Speaking|正在說|話しています|Hablando|말하는 중
正在等声音|Waiting for audio|正在等聲音|音声を待っています|Esperando audio|음성 대기 중
随时开口打断~随时开口打断。|Speak any time to interrupt.|隨時開口打斷。|いつでも話して割り込めます。|Habla cuando quieras para interrumpir.|언제든 말해서 끼어들 수 있어요.
连接正在恢复 · 随时开口打断|Reconnecting · speak any time to interrupt|連線正在恢復 · 隨時開口打斷|再接続中 · いつでも割り込めます|Reconectando · puedes interrumpir|다시 연결 중 · 언제든 끼어들 수 있어요
听到了，继续说|I hear you. Keep going.|聽到了，繼續說|聞こえています。続けてください。|Te escucho. Sigue.|들려요. 계속 말씀하세요.
停顿后会自动发送~停顿后会自动发送。|Sent automatically when you pause.|停頓後會自動傳送。|話し終えると自動送信します。|Se envía al hacer una pausa.|말을 멈추면 자동 전송됩니다.
直接说话，停顿后自动发送~直接说话，停顿后自动发送。|Speak naturally; pause to send.|直接說話，停頓後自動傳送。|話し終えると自動送信します。|Habla con naturalidad; haz una pausa para enviar.|편하게 말하세요. 멈추면 자동 전송됩니다.
先安静片刻，准备好后就可以说话~请允许使用麦克风，先安静片刻。|Allow the microphone, then stay quiet briefly before speaking.|允許使用麥克風後，先安靜片刻再說話。|マイクを許可し、少し静かにしてから話してください。|Permite el micrófono y espera un momento en silencio antes de hablar.|마이크를 허용한 후 잠시 조용히 있다가 말하세요.
请靠近麦克风说话|Speak closer to the microphone|請靠近麥克風說話|マイクに近づいて話してください|Acércate al micrófono|마이크 가까이에서 말하세요
继续说，或点结束对话~可以继续说话~已恢复，可以继续说话|Keep talking, or end the call|繼續說，或點結束對話|続けて話すか、通話を終了してください|Sigue hablando o finaliza la llamada|계속 말하거나 통화를 끝내세요
继续说话|Keep talking|繼續說話|話し続ける|Seguir hablando|계속 말하기
请再说一次~没有听清有效语音，请再说一次~没有听清有效语音，请再说一次。~这句话没听清，请再说一次。~这句话没听清，请靠近麦克风再说一次。|I didn't catch that. Please say it again.|這句話沒聽清，請再說一次。|聞き取れませんでした。もう一度お願いします。|No te he entendido. Repítelo, por favor.|잘 듣지 못했어요. 다시 말씀해 주세요.
正在准备回复~稍等一下，正在准备回复。|Preparing a reply. One moment.|正在準備回覆，請稍候。|応答を準備中です。少しお待ちください。|Preparando una respuesta. Un momento.|답변을 준비 중입니다. 잠시 기다리세요.
正在查询，稍候继续回复|Looking it up; the reply will continue shortly|正在查詢，稍後繼續回覆|確認中です。まもなく応答を続けます|Consultando; la respuesta continuará pronto|확인 중입니다. 곧 답변을 이어갑니다
声音还在路上，稍等一下。|Audio is on its way. One moment.|聲音還在路上，稍等一下。|音声を受信中です。少しお待ちください。|El audio está llegando. Un momento.|음성이 도착 중입니다. 잠시 기다리세요.
仅文字|Text only|僅文字|テキストのみ|Solo texto|텍스트만
你|You|你|あなた|Tú|나
回复|Reply|回覆|応答|Respuesta|답변
低|Low|低|低|Baja|낮음
较低|Lower|較低|やや低|Algo baja|조금 낮음
标准|Standard|標準|標準|Normal|보통
较高|Higher|較高|やや高|Algo alta|조금 높음
高|High|高|高|Alta|높음
开始聊天后可查看音量|Microphone level appears during a call|開始聊天後可查看音量|通話中に音量を表示|El nivel aparece durante la llamada|통화 중 마이크 음량 표시
已超过讲话阈值|Above speech threshold|已超過講話閾值|発話しきい値以上|Por encima del umbral de voz|발화 임계값 초과
未超过讲话阈值|Below speech threshold|未超過講話閾值|発話しきい値未満|Por debajo del umbral de voz|발화 임계값 미만
主人会话|Owner session|主人會話|オーナーの通話|Sesión del propietario|소유자 통화
本次|This call|本次|今回|Esta llamada|이번 통화
今日剩余|Remaining today|今日剩餘|本日の残り|Restante hoy|오늘 남은 시간
（已打断）~（回复已停止）|(Reply stopped)|（回覆已停止）|（応答停止）|(Respuesta detenida)|(답변 중지됨)
已停止 · 已收到的文字已补齐|Stopped · all received text is shown|已停止 · 已收到的文字已補齊|停止済み · 受信済みテキストを全文表示|Detenido · se muestra todo el texto recibido|중지됨 · 수신된 텍스트 모두 표시
上一句已打断，停顿后自动发送。|Reply interrupted; pause to send.|上一句已打斷，停頓後自動傳送。|応答を中断しました。話し終えると送信します。|Respuesta interrumpida; haz una pausa para enviar.|답변을 중단했습니다. 말을 멈추면 전송됩니다.
对话已暂停~通话已暂停|Call paused|對話已暫停|通話一時停止|Llamada en pausa|통화 일시 정지
连接已暂停~已连接，对话已暂停|Connected; call paused|已連線，對話已暫停|接続済み、通話一時停止|Conectado; llamada en pausa|연결됨, 통화 일시 정지
声音已暂停，点页面恢复|Audio paused. Tap the page to resume.|聲音已暫停，點頁面恢復|音声一時停止。画面をタップして再開。|Audio en pausa. Pulsa la página para reanudar.|음성 일시 정지. 페이지를 눌러 재개하세요.
已在后台暂停，返回页面后恢复~返回页面后继续。|Paused in background. Return to this page to resume.|已在背景暫停，返回頁面後恢復。|バックグラウンドで一時停止。画面に戻ると再開します。|En pausa en segundo plano. Vuelve a esta página para continuar.|백그라운드에서 일시 정지되었습니다. 페이지로 돌아오면 재개됩니다.
正在恢复麦克风|Restoring microphone|正在恢復麥克風|マイクを復旧中|Restaurando micrófono|마이크 복구 중
麦克风已恢复~麦克风已恢复，可以继续说话|Microphone restored. You can speak.|麥克風已恢復，可以繼續說話。|マイクが復旧しました。話せます。|Micrófono restaurado. Puedes hablar.|마이크가 복구되었습니다. 계속 말하세요.
麦克风暂时不可用，正在等待恢复|Microphone unavailable; waiting for recovery|麥克風暫時無法使用，正在等待恢復|マイクが使用できません。復旧を待っています|Micrófono no disponible; esperando recuperación|마이크를 사용할 수 없습니다. 복구를 기다리는 중
麦克风未恢复，请点结束后重新开启~请结束对话，再重新开启麦克风。~声音暂时无法继续。请结束对话，再重新开启麦克风。|End the call, then enable the microphone again.|請結束對話，再重新開啟麥克風。|通話を終了してマイクを有効にし直してください。|Finaliza la llamada y vuelve a activar el micrófono.|통화를 끝낸 후 마이크를 다시 켜세요.
声音暂时无法继续|Audio is temporarily unavailable|聲音暫時無法繼續|音声を継続できません|Audio no disponible temporalmente|지금은 음성을 계속할 수 없습니다
声音连接暂时无法恢复。请结束对话后重新开启。|Audio connection could not recover. End the call and start again.|聲音連線暫時無法恢復。請結束對話後重新開啟。|音声接続を復旧できません。通話を終了して再開してください。|No se pudo recuperar el audio. Finaliza la llamada y empieza de nuevo.|음성 연결을 복구하지 못했습니다. 통화를 끝내고 다시 시작하세요.
录音处理异常，请重新开启麦克风|Recording failed. Enable the microphone again.|錄音處理異常，請重新開啟麥克風|録音処理に失敗しました。マイクを有効にし直してください|Falló la grabación. Vuelve a activar el micrófono.|녹음 처리 오류입니다. 마이크를 다시 켜세요.
想聊时，再次开启麦克风~想聊时，再次开启麦克风。|Enable the microphone when you'd like to talk again.|想聊時，再次開啟麥克風。|また話したくなったらマイクを有効にしてください。|Activa el micrófono cuando quieras volver a hablar.|다시 이야기하고 싶으면 마이크를 켜세요.
请重新开启麦克风|Enable the microphone again|請重新開啟麥克風|マイクを有効にし直してください|Vuelve a activar el micrófono|마이크를 다시 켜세요
开启麦克风后才能对话|Enable the microphone to talk|開啟麥克風後才能對話|話すにはマイクを有効にしてください|Activa el micrófono para hablar|대화하려면 마이크를 켜세요
知道了|Got it|知道了|了解|Entendido|확인
重试|Retry|重試|再試行|Reintentar|재시도
重试开启麦克风|Retry microphone|重試開啟麥克風|マイクを再試行|Reintentar micrófono|마이크 다시 시도
重试连接~重新拨打~再次聊天|Call again|重新撥打|もう一度通話|Volver a llamar|다시 통화
结束并重新准备|End and try again|結束並重新準備|終了して再準備|Finalizar y reintentar|종료 후 다시 준비
查看打开方式|How to open|查看開啟方式|開き方を見る|Cómo abrir|여는 방법
我已确认，重试~确认设备可用后重试。|Check device access and retry|確認裝置可用後重試|デバイスを確認して再試行|Comprueba el dispositivo y reintenta|기기 확인 후 재시도
我已结束，重新连接|Other call ended; reconnect|已結束另一通話，重新連線|他の通話を終了、再接続|Otra llamada terminada; reconectar|다른 통화 종료, 다시 연결
请完全关闭后重新打开。|Close this page completely, then reopen it.|請完全關閉後重新開啟。|画面を完全に閉じて開き直してください。|Cierra esta página por completo y vuelve a abrirla.|페이지를 완전히 닫은 후 다시 여세요.
页面版本过旧|Page is out of date|頁面版本過舊|ページが古いバージョンです|Página desactualizada|페이지 버전이 오래됨
页面版本过旧，请关闭后重开。~页面版本过旧，请完全关闭后重新打开|This page is out of date. Close it and reopen.|頁面版本過舊，請關閉後重開。|ページが古いバージョンです。閉じて開き直してください。|Esta página está desactualizada. Ciérrala y vuelve a abrirla.|페이지 버전이 오래되었습니다. 닫은 후 다시 여세요.
麦克风准备超时|Microphone setup timed out|麥克風準備逾時|マイク準備がタイムアウトしました|Se agotó el tiempo del micrófono|마이크 준비 시간 초과
麦克风准备超时，请重试。~麦克风准备超时，已停止本次连接。请保持页面在前台，确认麦克风权限后点“重试开启麦克风”。|Microphone setup timed out. Keep this page open, check microphone permission, and retry.|麥克風準備逾時。請保持頁面在前景，確認麥克風權限後重試。|マイク準備がタイムアウトしました。画面を開いたまま権限を確認し、再試行してください。|Se agotó el tiempo. Mantén esta página abierta, comprueba el permiso del micrófono y reintenta.|마이크 준비 시간이 초과되었습니다. 페이지를 열어 두고 마이크 권한을 확인한 후 다시 시도하세요.
点“重试开启麦克风”重新连接|Tap Retry microphone to reconnect|點「重試開啟麥克風」重新連線|「マイクを再試行」で再接続|Pulsa Reintentar micrófono para reconectar|마이크 다시 시도를 눌러 연결하세요
麦克风权限未开启|Microphone permission is off|麥克風權限未開啟|マイクが許可されていません|Micrófono sin permiso|마이크 권한 꺼짐
麦克风权限未开启，请在系统或站点设置中允许。~麦克风权限未开启，请在系统或站点设置中允许后重试。~麦克风权限未开启，请在系统设置中允许后重试。|Allow microphone access in system or site settings, then retry.|請在系統或網站設定中允許使用麥克風後重試。|システムまたはサイトの設定でマイクを許可して再試行してください。|Permite el micrófono en los ajustes del sistema o del sitio y reintenta.|시스템 또는 사이트 설정에서 마이크를 허용한 후 다시 시도하세요.
无法开启麦克风~麦克风无法开启，请重试。|Cannot enable microphone. Please retry.|無法開啟麥克風，請重試。|マイクを有効にできません。再試行してください。|No se puede activar el micrófono. Reintenta.|마이크를 켤 수 없습니다. 다시 시도하세요.
无法开启麦克风，请在支持录音的 ClawNest 页面重试。|Cannot enable microphone. Retry in a ClawNest page that supports recording.|無法開啟麥克風，請在支援錄音的 ClawNest 頁面重試。|マイクを有効にできません。録音対応の ClawNest 画面で再試行してください。|No se puede activar el micrófono. Reintenta en una página de ClawNest que admita grabación.|마이크를 켤 수 없습니다. 녹음을 지원하는 ClawNest 페이지에서 다시 시도하세요.
请在弹窗里允许麦克风|Allow the microphone in the prompt|請在彈出視窗中允許麥克風|表示されたダイアログでマイクを許可してください|Permite el micrófono en el aviso|팝업에서 마이크를 허용하세요
允许使用麦克风后，再回来重试。|Allow microphone access, then return and retry.|允許使用麥克風後，再回來重試。|マイクを許可してから戻って再試行してください。|Permite el micrófono, vuelve y reintenta.|마이크를 허용한 후 돌아와 다시 시도하세요.
保持页面在前台，确认权限后重试。|Keep the page in the foreground, check permissions and retry.|保持頁面在前景，確認權限後重試。|画面を開いたまま権限を確認して再試行してください。|Mantén la página en primer plano, comprueba los permisos y reintenta.|페이지를 열어 두고 권한을 확인한 후 다시 시도하세요.
此浏览器不支持经典页面的麦克风隔离，请返回语音聊天页面。|This browser cannot isolate the classic page microphone. Return to the main Voice page.|此瀏覽器不支援經典頁面的麥克風隔離，請返回語音聊天頁面。|このブラウザーはクラシック画面のマイク分離に非対応です。メインの音声画面に戻ってください。|El navegador no aísla el micrófono de la página clásica. Vuelve a la página principal de Voz.|이 브라우저는 클래식 페이지 마이크 격리를 지원하지 않습니다. 기본 음성 페이지로 돌아가세요.
听到提示音了，稍等一下|Alert detected. One moment.|聽到提示音了，稍等一下|通知音を検出しました。少しお待ちください|Aviso detectado. Un momento.|알림음이 감지되었습니다. 잠시 기다리세요
（诊断码|(Diagnostic code|（診斷碼|（診断コード|(Código de diagnóstico|(진단 코드
），请重试。|). Please retry.|），請重試。|）。再試行してください。|). Reintenta.|). 다시 시도하세요.
`.trim().split('\n'));
  rows.push(...`
已有一段语音对话~已有一段语音对话，请先结束。~已有一段语音对话，请先结束另一页。~你已有一段语音对话，请先结束另一页。|Another voice call is active. End it first.|已有一段語音對話，請先結束另一頁。|別の音声通話が進行中です。先に終了してください。|Ya hay otra llamada. Finalízala primero.|다른 음성 통화가 진행 중입니다. 먼저 종료하세요.
请先结束另一页，再回来连接。|End the call on the other page, then return.|請先結束另一頁，再回來連線。|他の画面の通話を終了して戻ってください。|Finaliza la llamada en la otra página y vuelve.|다른 페이지의 통화를 종료한 후 돌아오세요.
当前会话已满~当前会话已满，请稍后重试。~当前语音会话已满，请稍后重试。|All voice sessions are busy. Try again later.|目前語音會話已滿，請稍後重試。|通話の上限に達しています。後で再試行してください。|Todas las sesiones están ocupadas. Inténtalo más tarde.|음성 통화가 모두 사용 중입니다. 나중에 다시 시도하세요.
今天先聊到这里~今日语音时长已用完。~今天的语音时长已用完，明天再聊。|Today's voice time is used up. Talk again tomorrow.|今天的語音時長已用完，明天再聊。|本日の音声時間を使い切りました。また明日お話ししましょう。|Se acabó el tiempo de voz de hoy. Hablamos mañana.|오늘 음성 시간을 모두 사용했습니다. 내일 다시 이야기해요.
本次语音已到时长上限。~本次语音已达到时长上限。~本次语音已到时长上限，可以再开一段。|This call reached its time limit. You can start another.|本次語音已達時長上限，可以再開一段。|通話の制限時間に達しました。新しい通話を開始できます。|Esta llamada alcanzó su límite. Puedes iniciar otra.|통화 시간 한도에 도달했습니다. 새 통화를 시작할 수 있습니다.
主人已开始聊天，本次对话结束。~主人开始了语音，本次对话已结束。|The owner started a call, so this call has ended.|主人開始了語音，本次對話已結束。|オーナーが通話を開始したため、この通話は終了しました。|El propietario inició una llamada y esta ha terminado.|소유자가 통화를 시작하여 이 통화가 종료되었습니다.
一段时间没有说话，已自动结束。|The call ended after a period of silence.|一段時間沒有說話，已自動結束。|しばらく発話がなかったため、自動終了しました。|La llamada terminó tras un período de silencio.|한동안 말이 없어 통화가 자동 종료되었습니다.
空闲超时，点击绿色按钮重新拨打。|Call ended due to inactivity. Tap the green button to call again.|閒置逾時，點擊綠色按鈕重新撥打。|無操作で終了しました。緑のボタンで再度通話できます。|Terminó por inactividad. Pulsa el botón verde para volver a llamar.|사용하지 않아 종료되었습니다. 초록색 버튼을 눌러 다시 통화하세요.
会话已达上限，点击绿色按钮重新拨打。|Call time limit reached. Tap the green button to call again.|會話已達上限，點擊綠色按鈕重新撥打。|制限時間に達しました。緑のボタンで再度通話できます。|Se alcanzó el límite. Pulsa el botón verde para volver a llamar.|통화 한도에 도달했습니다. 초록색 버튼을 눌러 다시 통화하세요.
好友语音暂不可用~请先添加好友并开启好友语音。~请先添加好友，并请主人开启好友语音。~请确认已添加好友，且主人已开启好友语音。|Friend voice is unavailable. Add each other as friends and ask the owner to enable it.|好友語音暫無法使用。請先加為好友，並請主人開啟好友語音。|友達の音声通話は利用できません。友達に追加し、オーナーに有効化を依頼してください。|La voz para amigos no está disponible. Añadíos como amigos y pide al propietario que la active.|친구 음성을 사용할 수 없습니다. 친구로 추가하고 소유자에게 활성화를 요청하세요.
好友暂不可用：|Friend voice unavailable:|好友暫無法使用：|友達の音声通話は利用不可：|Voz para amigos no disponible:|친구 음성 사용 불가:
上一条回复仍在停止，本次语音未能提交。请稍后重新说一遍。~上一条回复仍在停止，请稍后重新说一遍。~仍在停止上一条回复，请稍候。~播放已停止，服务暂未确认取消；请稍等再说。|The previous reply is still stopping. Wait a moment, then say it again.|上一條回覆仍在停止，請稍後重新說一遍。|前の応答を停止中です。少し待ってからもう一度話してください。|La respuesta anterior sigue deteniéndose. Espera y repítelo.|이전 답변을 중지 중입니다. 잠시 후 다시 말씀하세요.
上传较慢，请稍后再说。~上传较慢，这段录音已丢弃，请稍后再说。|Upload is too slow; this recording was discarded. Please speak again later.|上傳較慢，這段錄音已捨棄，請稍後再說。|アップロードが遅いため、この録音は破棄されました。後でもう一度話してください。|La subida es lenta; se descartó esta grabación. Habla de nuevo más tarde.|업로드가 느려 녹음을 삭제했습니다. 잠시 후 다시 말씀하세요.
SSE 下行无法恢复，请重新开始对话。~下行数据中断，请重试。~语音播放中断，请重新开始对话。|Audio download was interrupted. Start the call again.|下行資料中斷，請重新開始對話。|音声の受信が中断されました。通話を再開してください。|Se interrumpió la descarga de audio. Inicia la llamada de nuevo.|음성 수신이 중단되었습니다. 통화를 다시 시작하세요.
声音连接中断，正在重连。~语音数据中断，正在重新连接。~连接中断，正在重连。|Voice connection interrupted. Reconnecting.|語音連線中斷，正在重新連線。|音声接続が切れました。再接続中です。|Conexión de voz interrumpida. Reconectando.|음성 연결이 끊겼습니다. 다시 연결 중입니다.
连接中断，正在重连；这段录音不会重发~网络已断开，正在重连；这段录音不会重发|Connection lost. Reconnecting; this recording will not be resent.|連線中斷，正在重新連線；這段錄音不會重傳。|接続が切れました。再接続中です。この録音は再送しません。|Conexión perdida. Reconectando; esta grabación no se reenviará.|연결이 끊겨 다시 연결 중입니다. 이 녹음은 다시 전송하지 않습니다.
刚才这段录音不会重发。连接后请再说一次。|This recording will not be resent. Say it again after reconnecting.|剛才這段錄音不會重傳。連線後請再說一次。|この録音は再送しません。再接続後にもう一度話してください。|Esta grabación no se reenviará. Repítelo tras reconectar.|이 녹음은 다시 전송하지 않습니다. 연결 후 다시 말씀하세요.
旧连接|Previous connection|舊連線|前の接続|Conexión anterior|이전 연결
旧连接正在释放，正在重连|Previous connection is closing. Reconnecting.|舊連線正在釋放，正在重新連線|前の接続を終了しています。再接続中|Conexión anterior cerrándose. Reconectando.|이전 연결 해제 중. 다시 연결 중
连接响应超时，正在重连|Connection timed out. Reconnecting.|連線回應逾時，正在重新連線|接続がタイムアウトしました。再接続中|Conexión agotada. Reconectando.|연결 시간 초과. 다시 연결 중
语音连接超时，请重新拨打。|Voice connection timed out. Call again.|語音連線逾時，請重新撥打。|音声接続がタイムアウトしました。かけ直してください。|La conexión de voz ha caducado. Vuelve a llamar.|음성 연결 시간이 초과되었습니다. 다시 전화하세요.
麦克风已开启，但声音校准超时。请重新拨打。|Microphone is on, but audio calibration timed out. Call again.|麥克風已開啟，但聲音校準逾時。請重新撥打。|マイクは有効ですが、音声の調整がタイムアウトしました。かけ直してください。|El micrófono está activo, pero la calibración ha caducado. Vuelve a llamar.|마이크는 켜져 있지만 오디오 보정 시간이 초과되었습니다. 다시 전화하세요.
连接未能恢复~重连未成功，请再次开启麦克风~重连未成功，请重新拨打~连接未恢复，点击绿色按钮重新拨打。~重新连接未成功。检查网络后，点击绿色按钮重新拨打。|Could not reconnect. Check your network and call again.|重新連線未成功。請檢查網路後重新撥打。|再接続できませんでした。ネットワークを確認して再度通話してください。|No se pudo reconectar. Comprueba la red y vuelve a llamar.|다시 연결하지 못했습니다. 네트워크를 확인하고 다시 통화하세요.
网络异常，请检查网络。~网络连接异常，请检查网络。~检查网络后重新连接。|Check your network connection and retry.|請檢查網路連線後重試。|ネットワーク接続を確認して再試行してください。|Comprueba la conexión de red y reintenta.|네트워크 연결을 확인한 후 다시 시도하세요.
连接异常：|Connection error:|連線異常：|接続エラー：|Error de conexión:|연결 오류:
语音服务暂不可用（|Voice service unavailable (|語音服務暫無法使用（|音声サービスが利用できません（|Servicio de voz no disponible (|음성 서비스 사용 불가 (
语音服务暂时不可用，请稍后重试。~请稍后重试。|Voice service is temporarily unavailable. Try again later.|語音服務暫無法使用，請稍後重試。|音声サービスを一時的に利用できません。後で再試行してください。|El servicio de voz no está disponible. Inténtalo más tarde.|음성 서비스를 일시적으로 사용할 수 없습니다. 나중에 다시 시도하세요.
语音服务现在比较忙，请稍等几秒再说一次。|The voice service is busy. Please wait a few seconds and try again.|語音服務現在比較忙，請稍等幾秒再說一次。|音声サービスが混み合っています。数秒待ってからもう一度話してください。|El servicio de voz está ocupado. Espera unos segundos y repite.|음성 서비스가 혼잡합니다. 몇 초 후 다시 말씀하세요.
语音识别现在比较忙，请稍等几秒再说一次。|Speech recognition is busy. Please wait a few seconds and try again.|語音辨識現在比較忙，請稍等幾秒再說一次。|音声認識が混み合っています。数秒待ってからもう一度話してください。|El reconocimiento de voz está ocupado. Espera unos segundos y repite.|음성 인식이 혼잡합니다. 몇 초 후 다시 말씀하세요.
语音识别暂时不可用，这句话未能识别，请稍后重新说一次。|Speech recognition is unavailable. Please say it again later.|語音辨識暫無法使用，請稍後重新說一次。|音声認識を利用できません。後でもう一度話してください。|El reconocimiento de voz no está disponible. Repítelo más tarde.|음성 인식을 사용할 수 없습니다. 잠시 후 다시 말씀하세요.
回复暂时没能完成，请重新说一次。~回复生成失败，请重新说一次。~回复连接中断，请重新说一次。|The reply could not complete. Please say it again.|回覆暫時無法完成，請重新說一次。|応答を完了できませんでした。もう一度話してください。|No se pudo completar la respuesta. Repítelo.|답변을 완료하지 못했습니다. 다시 말씀하세요.
回复等待有点久，请重新说一次。~回复等待超时，请重新说一次。|The reply took too long. Please say it again.|回覆等待逾時，請重新說一次。|応答に時間がかかりすぎました。もう一度話してください。|La respuesta tardó demasiado. Repítelo.|답변 대기 시간이 초과되었습니다. 다시 말씀하세요.
回复的声音生成失败，文字已保留。请再说一次。~回复的声音生成失败，请再说一次。~语音播放生成失败，请再试一次。|Could not generate reply audio. Text is retained; please try again.|回覆的聲音產生失敗，文字已保留。請再試一次。|応答音声を生成できませんでした。テキストは保持されています。再試行してください。|No se pudo generar el audio. El texto se conserva; reintenta.|답변 음성을 생성하지 못했습니다. 텍스트는 유지됩니다. 다시 시도하세요.
声音已播放，但聊天记录写入未确认。~声音已播放，但聊天记录写入未确认。请到聊天中查看。|Audio played, but chat history was not confirmed. Check your chat.|聲音已播放，但聊天記錄寫入未確認。請到聊天中查看。|音声は再生済みですが、チャットへの記録は未確認です。チャットを確認してください。|Audio reproducido, pero el historial no se confirmó. Revisa tu chat.|음성은 재생되었지만 채팅 저장은 확인되지 않았습니다. 채팅에서 확인하세요.
SSE 尚未连接，请稍后重试。|SSE is not connected. Try again shortly.|SSE 尚未連線，請稍後重試。|SSE 未接続です。後で再試行してください。|SSE sin conectar. Reintenta en breve.|SSE가 연결되지 않았습니다. 잠시 후 다시 시도하세요.
稳态|Steady|穩態|一定|Constante|일정
突发|Burst|突發|バースト|Ráfaga|버스트
中断|Interrupted|中斷|中断|Interrumpido|중단됨
未知|Unknown|未知|不明|Desconocido|알 수 없음
手动停止|Stopped manually|手動停止|手動停止|Detenido manualmente|수동 중지
等待测试结果超时|Timed out waiting for test results|等待測試結果逾時|テスト結果の待機がタイムアウト|Tiempo agotado esperando resultados|테스트 결과 대기 시간 초과
测试完成。结果已上传；可截图对照。|Test complete. Results uploaded; take a screenshot to compare.|測試完成。結果已上傳；可截圖對照。|テスト完了。結果を送信済みです。比較用に画面を保存できます。|Prueba terminada. Resultados subidos; puedes capturar para comparar.|테스트 완료. 결과를 업로드했습니다. 비교할 화면을 저장할 수 있습니다.
测试已停止。已保留结果；连接恢复后会补传摘要。|Test stopped. Results saved; the summary will upload after reconnecting.|測試已停止。已保留結果；連線恢復後會補傳摘要。|テスト停止。結果を保持し、再接続後に概要を送信します。|Prueba detenida. Resultados guardados; el resumen se subirá al reconectar.|테스트 중지. 결과가 저장되었으며 연결 복구 후 요약을 업로드합니다.
：测试中（10 秒）|: testing (10 seconds)|：測試中（10 秒）|：テスト中（10秒）|: probando (10 segundos)|: 테스트 중 (10초)
/ 缺|/ missing|/ 缺|/ 欠落|/ faltan|/ 누락
`.trim().split('\n'));
  const catalog = Object.create(null);
  for (const row of rows) {
    const [sources, ...values] = row.split('|');
    if (values.length !== locales.length) throw Error('Invalid Voice translation row');
    for (const source of sources.split('~')) catalog[source] = Object.fromEntries(locales.map((lang, i) => [lang, values[i]]));
  }
  function normalize(value) {
    const tag = String(value || '').trim().toLowerCase().replace(/_/g, '-');
    if (/^zh(?:-|$)/.test(tag)) return /^zh-(?:tw|hk|mo|hant)(?:-|$)/.test(tag) ? 'zh-TW' : 'zh-CN';
    const base = tag.split('-')[0];
    return ['en', 'ja', 'es', 'ko'].includes(base) ? base : null;
  }
  function select(search, languages) {
    const params = new URLSearchParams(search);
    for (const key of ['lang', 'locale', 'language']) {
      const value = params.get(key);
      if (value?.trim()) return normalize(value) || 'en';
    }
    for (const value of languages || []) { const lang = normalize(value); if (lang) return lang; }
    return 'en';
  }
  const locale = select(root.location?.search || '', root.navigator?.languages || [root.navigator?.language]);
  function translate(source, lang = locale) {
    if (lang === 'zh-CN') return source;
    const key = source.trim(), value = catalog[key]?.[lang] || catalog[key]?.en;
    return value ? source.replace(key, () => value) : source;
  }
  function localize(document) {
    document.documentElement.lang = locale;
    document.title = translate(document.title);
    // One pass before page.js runs; no observer touches user or generated text.
    const walker = document.createTreeWalker(document.body, 4);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!['SCRIPT', 'STYLE'].includes(node.parentElement?.tagName)) node.nodeValue = translate(node.nodeValue);
    }
    for (const node of document.body.querySelectorAll('[aria-label], [title], [placeholder]')) {
      for (const attr of ['aria-label', 'title', 'placeholder']) {
        if (node.hasAttribute(attr)) node.setAttribute(attr, translate(node.getAttribute(attr)));
      }
    }
  }
  const api = {locale, t: translate, normalize, select, catalog};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.VoiceI18n = api; localize(root.document); }
})(typeof window === 'undefined' ? globalThis : window);
