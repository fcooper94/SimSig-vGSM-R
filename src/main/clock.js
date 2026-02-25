let clockState = {
  areaId: '',
  clockSeconds: 0,
  interval: 500,
  paused: false,
};

function updateClock(clockMsg) {
  if (clockMsg.area_id) clockState.areaId = clockMsg.area_id;
  if (clockMsg.clock != null) clockState.clockSeconds = parseInt(clockMsg.clock, 10);
  if (clockMsg.interval != null) clockState.interval = parseInt(clockMsg.interval, 10);
  if (clockMsg.paused != null) clockState.paused = clockMsg.paused === 'True' || clockMsg.paused === true;
}

// Update clock time from the time field present in most SimSig messages
function updateClockTime(time) {
  const t = parseInt(time, 10);
  if (!isNaN(t) && t > 0) {
    clockState.clockSeconds = t;
  }
}

function getClockState() {
  return { ...clockState };
}

function getSpeedRatio() {
  return clockState.interval > 0 ? 500 / clockState.interval : 1;
}

function formatTime(seconds) {
  const s = parseInt(seconds, 10);
  const hours = Math.floor(s / 3600) % 24;
  const minutes = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

module.exports = { updateClock, updateClockTime, getClockState, getSpeedRatio, formatTime };
