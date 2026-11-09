// Runs in the extension's isolated world. Relays toolbar-button clicks to the
// panel, which runs in the page so it can use YouTube Music's own session.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && (msg.type === 'playlist-tidy:toggle' || msg.type === 'playlist-tidy:open')) {
    window.dispatchEvent(new CustomEvent(msg.type));
    reply({ ok: true });
  }
});
