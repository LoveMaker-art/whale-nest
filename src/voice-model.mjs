export const fastVoiceModel = {provider:'clawling-voice',model:'deepseek-v4.1-flash'};

function sameModel(left,right) {
  return left?.provider===right.provider && left.model===right.model;
}

export function selectFastVoiceModel(models,selection) {
  const active=selection??models.find(model=>model.isDefault)?.selection;
  if (!sameModel(active,{provider:'clawling',model:fastVoiceModel.model})) return null;
  const route=models.find(model=>sameModel(model.selection,fastVoiceModel));
  return route?.supportedReasoningEfforts?.includes('off')
    ? {model:route.selection,reasoningEffort:'off'} : null;
}
