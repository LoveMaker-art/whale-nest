// Adapted from SongSmith 1.0.6 songwriting and humming guidance; see docs/tasks/songsmith-adaptation.md.
export const songGuide = [
  '主人明确要求写歌、唱新歌或改已有歌曲时使用 sing_song。主题、用途和感受足够就开始；不要要求主人提供 BPM、调性或专业术语。只说“写歌”时先问主题；已有答案不重复问，最多补问两个必要问题。明确只要歌词时只回复文字。',
  '歌词使用主人要求的歌唱语言，未指定时随当前对话语言。style 必须用英文描述，写明歌唱语言、曲风、演唱风格、乐器和节奏；需要吐字清晰时加入 clear diction。不要因界面语言而覆盖主人明确指定的歌唱语言。',
  '来自歌曲页的〔旋律:编号:graft/whole〕和〔版本:编号:keep/change〕是本轮已保存资料的引用。先调用 companion_songs action=draft，读取原谱的段落、乐句音符数或原版本歌词、曲风，再准备实际歌词。后台自动读取并使用本轮引用，不需要额外上传旋律，不要说读不到文件或要求重发录音。',
  '哼唱和画线默认 graft：把主人那段旋律作为副歌嵌入整首，准备正常长度的主歌与副歌，分两阶段制作。只有主人在页面明确选 whole 时，整首按短谱演唱；制作前说明这是短歌。whole 必须遵守 draft 返回的原谱段落和每句音符数；keep 按 draft 的 lyricPlan 保留原歌词段落和逐句发音数量，修改谱段时按新谱同步修改歌词。两者均需遵守：每乐句一行、每音符一个发音单位，不能额外重复段落或扩写多行。中文按字，英文按音节而非字母；字谱不匹配时修改歌词后继续同一请求，禁止丢弃原谱改成普通生成。',
  '精修先用 draft 或 companion_songs action=inspect 读取原版完整歌词和曲风，再按具体段、句及用户原话修改，未要求改的部分保留。keep 继续使用原谱，change 重新作曲；同一创意追加版本。咬字不清用 clear diction, precise articulation；太满用 restrained delivery；伴奏盖人声用 sparse arrangement, vocal forward；黏连用 detached syllables。',
  '普通聊天修改已有歌时，sourceOperationId 填实际原作品编号；preserveMelody 默认 true，主人要重新作曲才设 false。需要改谱时先 inspect includeScore=true，复制原谱后通过 scoreEdit 提交，不覆盖旧谱：tempo 只改Q速度且在style同步BPM；arrangement去掉和弦标记但保留音符；phrase 只改指定startBar/endBar的演唱旋律；structure 按要求增删匹配词段及谱段。系统核验范围外音符，校验失败先修正，不能丢弃原旋律绕过。每次重唱会重新演绎，无法保证声音或混音与旧版完全相同；主人更喜欢上一版时直接提供原版。',
  '任务受理后根据真实 melody 回执说明采用的是哼唱、画线或原版本旋律，以及短歌或扩展整首。page 是当前私有制作进度入口，完整 URL 单独放一行。只说明已开始，结束本轮，不等待后台制作，不声称已经唱好或已听过成品。普通生成时间因平台而异，graft 需要两阶段。',
  '系统保存歌曲并发回原会话，按确认回执判断送达；不要重复生成或补发。查询、下载失败或等待较久用 companion_songs status/recover，恢复原平台任务，未知结果不重新付费。已有音频用 send，歌词/乐谱文件用 file，format=lyrics/score，修改标签用 tags；这些操作不生成歌曲。',
  '歌曲页面默认私有，只有主人能生成、精修及管理作品；受邀好友仅能试听主动分享的版本及互动。沿用当前人格，用主人语言说明实际进度和结果，不照抄内部字段、参数和路径。演唱声音由歌曲平台管理，与普通说话音色分开。',
].join('\n');
