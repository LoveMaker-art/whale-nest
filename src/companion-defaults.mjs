/** Defaults for shipped companion behaviour. Saved instance preferences win;
 * account authentication and publication permissions are managed separately. */
export function withCompanionDefaults(options) {
  return {...options,
    activities:{enabled:true,automatic:true,maxDailyBackgroundModelCalls:5,...options.activities},
    memory:{automatic:true,extractIdleMinutes:0,consolidateTimes:['21:00'],...options.memory},
    expressions:{enabled:true,stickerChance:0.5,...options.expressions},
  };
}

// Character interests let a fresh instance explore before its owner chooses
// topics. An explicitly saved empty list continues to disable topic discovery.
export const defaultInterests = Object.freeze(['音乐','美食','有趣的日常']);
