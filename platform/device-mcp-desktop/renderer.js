const heading = document.querySelector('h1');
const detail = document.querySelector('#detail');
const indicator = document.querySelector('#indicator');
const reconnect = document.querySelector('#reconnect');
const enableBrowser = document.querySelector('#enable-browser');
const disconnect = document.querySelector('#disconnect');
function render(status) {
  heading.textContent = status.title;
  detail.textContent = status.detail;
  indicator.dataset.state = status.state;
  indicator.textContent = status.state === 'online' ? 'Connected' : status.state === 'error' ? 'Needs attention' : status.state === 'connecting' ? 'Connecting' : 'Ready to connect';
  enableBrowser.hidden = !status.canEnableBrowserConnection;
  reconnect.hidden = !status.canReconnect;
  disconnect.hidden = !['online', 'connecting'].includes(status.state);
}
enableBrowser.addEventListener('click', () => window.connector.enableBrowserConnections());
reconnect.addEventListener('click', () => window.connector.reconnect());
disconnect.addEventListener('click', () => window.connector.disconnect());
window.connector.onStatus(render);
window.connector.status().then(render);
