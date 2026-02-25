document.addEventListener('DOMContentLoaded', () => {
  MessageFeed.init();

  window.simsigAPI.messages.onMessage((msg) => {
    MessageFeed.handleMessage(msg);
  });
});
