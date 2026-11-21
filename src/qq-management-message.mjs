/** User-facing facts from the one QQ controller; no account actions live here. */
export function qqManagementMessage(value) {
  if(value.message)return value.message;
  const proof=value.association;
  if(value.change&&['queued','applying','data-applied'].includes(value.change.state))
    return '确认已收到，正在启用QQ聊天。完成后我会自动告诉你。';
  if(proof?.state==='preparing')return '正在准备QQ身份验证，准备好后会给你验证文字。';
  if(proof?.state==='waiting')return `尚未收到有效的QQ验证。请用你的QQ ${proof.ownerQQ} 私聊我的QQ ${proof.botQQ}，发送上一条验证文字，再回这里发送“确认关联 ${proof.ownerQQ}”。${proof.remainingSeconds}秒内完成这两步。`;
  if(proof?.state==='verified')return `QQ身份验证通过。请在剩余${proof.remainingSeconds}秒内回这里发送“确认关联 ${proof.ownerQQ}”。`;
  if(value.binding&&value.verified&&value.connection==='connected')
    return `QQ已连接。我的QQ：${value.binding.botQQ}；你的QQ：${value.binding.ownerQQ}。现在可以去QQ私聊我了。`;
  if(value.nextAction==='provide-owner-qq')return '机器人 QQ 已登录。告诉我你用来私聊我的个人 QQ 号，我会带你完成主人关联。';
  if(value.nextAction==='wait-for-channel')return '原机器人 QQ 已登录。我正在核实聊天通道是否恢复。';
  if(value.binding&&value.login?.state==='offline')return '原QQ关联还在，需要原机器人QQ扫码重新登录。';
  if(value.binding&&value.login?.state==='reconnecting')return '原QQ关联还在，网关正在恢复QQ聊天通道。';
  if(proof?.state==='expired')return '本次绑定验证已过期，旧验证文字已失效。需要继续时请说“重新绑定QQ”，取得新的验证文字。';
  if(proof?.state==='interrupted')return '本次绑定验证因服务重启中断。需要继续时请说“重新绑定QQ”，取得新的验证文字。';
  if(proof?.state==='failed')return proof.problem??'本次QQ验证准备失败，尚未开始等待你操作。请稍后重新绑定QQ。';
  if(proof?.state==='cancelled')return '本次绑定验证已取消。需要继续时请重新发起绑定。';
  if(value.login?.state==='scanned')return '已扫码，正在等待手机QQ允许登录；我会自动核验结果。';
  if(value.login?.state==='security-restricted')return 'QQ提示账号安全限制。请先按最新版手机QQ的提示恢复账号使用，再重新连接QQ。';
  if(value.login?.state==='restarting'||value.login?.state==='reconnecting')return 'QQ 网关正在恢复。过一会儿可以让我查一下进度。';
  if(value.login?.state==='expired')return 'QQ登录二维码已过期。需要继续时请说“刷新QQ登录二维码”。';
  if(value.login?.state==='waiting'&&value.login?.delivery?.state==='confirmed')return 'QQ正在等待扫码登录，手机确认后会自动核验并通知你。';
  if(value.binding)return 'QQ账号已关联，聊天通道尚未核实可用。正在检查连接结果。';
  if(value.login?.state==='online')return '大肥鱼的QQ已登录。下一步请告诉我你用来聊天的个人QQ号，完成主人关联。';
  return value.configured?'QQ尚未连接，可以在这里发起QQ登录。':'QQ接入尚未配置，请先完成实例的QQ接入配置。';
}

/** Render known outcomes if the current ClawChat turn has no model answer. */
export function qqManagementFallback(result) {
  if (result.qrDelivery === 'delivered') return '二维码发给你了。用准备给我的那个QQ扫码，在手机上确认后我会继续检查。';
  if (result.qrDelivery === 'send-failed') return '二维码准备好了，但这次没发出去。你可以让我刷新一下。';
  if (result.qrDelivery === 'unconfirmed') return '二维码是否送到还需要确认。你可以先看看聊天里有没有收到。';
  if (result.qrDelivery === 'preparation-failed') return result.login?.state === 'attention-required'
    ? 'QQ 正停在需要处理的登录页面，二维码还没生成。'
    : '这次没能准备好二维码。过一会儿可以再试。';
  if (result.loginCancelled) return '这次扫码登录已取消。';
  if (result.verificationText || result.verificationReused) {
    const proof = result.association;
    const timing = proof.remainingSeconds > 0 ? '请在 '+proof.remainingSeconds+' 秒内完成。' : '';
    const instructions = result.verificationText ? '发送下面的验证文字' : '发送之前的验证文字';
    return '请用你的QQ '+proof.ownerQQ+' 私聊我的QQ '+proof.botQQ+'，'+instructions+'，再回这里确认。'+timing;
  }
  if (result.confirmationRequired && !result.confirmationRequired.startsWith('确认关联 ')) return '还需要你在这里发送下面的确认口令。';
  if (result.ok === false) {
    if (result.errorCode === 'no-binding') return '还没关联你的QQ。完成关联后就可以继续。';
    return result.detail || '这次QQ操作还没完成。你可以先查一下QQ状态，再决定下一步。';
  }
  if (result.change && ['queued','applying','data-applied'].includes(result.change.state)) {
    const action = {disconnect:'断开QQ聊天',unlink:'解除QQ关联'}[result.change.action] ?? '启用QQ聊天';
    return '确认收到了，我正在'+action+'。完成后会告诉你。';
  }
  if (result.login?.state === 'timed-out') return 'QQ登录等了一段时间，还没核实成功。我会继续检查，也可以按你的要求刷新二维码。';
  if (result.login?.state === 'failed') return 'QQ登录还没完成。可以先看看手机QQ提示，或者让我刷新二维码。';
  if (result.login?.state === 'wrong-account') return '扫码登录的QQ号和这次指定的号码不一致。请检查扫码账号。';
  return qqManagementMessage(result);
}
