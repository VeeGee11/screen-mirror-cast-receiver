const context = cast.framework.CastReceiverContext.getInstance();
const playerManager = context.getPlayerManager();

playerManager.addEventListener(cast.framework.events.EventType.ERROR, (event) => {
  console.error('[Receiver] Player ERROR:', JSON.stringify(event));
});

playerManager.addEventListener(cast.framework.events.EventType.PLAYER_LOAD_COMPLETE, () => {
  console.log('[Receiver] PLAYER_LOAD_COMPLETE');
});

playerManager.addEventListener(cast.framework.events.EventType.BUFFERING, (event) => {
  console.log('[Receiver] BUFFERING:', JSON.stringify(event));
});

playerManager.addEventListener(cast.framework.events.EventType.PLAYING, () => {
  console.log('[Receiver] PLAYING');
});

playerManager.addEventListener(cast.framework.events.EventType.MEDIA_STATUS, (event) => {
  console.log('[Receiver] MEDIA_STATUS:', JSON.stringify(event));
});

playerManager.addEventListener(cast.framework.events.EventType.ALL, (event) => {
  console.log('[Receiver] EVENT:', event.type);
});

const options = new cast.framework.CastReceiverOptions();
options.maxInactivity = 3600;

context.start(options);

console.log('[Receiver] Started');
