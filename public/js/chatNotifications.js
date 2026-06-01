let lastChatMessageId = Number(localStorage.getItem('lastChatMessageId') || 0);
let currentToastLeagueId = null;

async function initChatNotifications() {
  if (lastChatMessageId !== 0) return;

  const res = await fetch('/chat/latest-id');
  const data = await res.json();

  lastChatMessageId = Number(data.latestId || 0);
  localStorage.setItem('lastChatMessageId', lastChatMessageId);
}

async function checkChatNotifications() {
  const toast = document.getElementById('chatToast');
  if (!toast) return;

  try {
    const res = await fetch('/chat/notifications?sinceId=' + lastChatMessageId);
    const messages = await res.json();

    if (!messages.length) return;

    const latest = messages[messages.length - 1];

    lastChatMessageId = Number(latest.id);
    localStorage.setItem('lastChatMessageId', lastChatMessageId);

    currentToastLeagueId = latest.league_id;

    document.getElementById('chatToastTitle').textContent =
      latest.league_name + ' • ' + latest.username;

    document.getElementById('chatToastText').textContent =
      latest.message;

    toast.classList.add('show-chat-toast');

    setTimeout(() => {
      toast.classList.remove('show-chat-toast');
    }, 6000);
  } catch (err) {}
}

function openChatToast() {
  if (!currentToastLeagueId) return;
  window.location.href = '/league/' + currentToastLeagueId + '/chat';
}

document.addEventListener('DOMContentLoaded', async () => {
  const toast = document.getElementById('chatToast');

  if (toast) {
    toast.addEventListener('click', openChatToast);
  }

  await initChatNotifications();

  setInterval(checkChatNotifications, 5000);
});