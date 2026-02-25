const TimeUtils = {
  formatSecondsFromMidnight(seconds) {
    const s = parseInt(seconds, 10);
    if (isNaN(s)) return '--:--:--';
    const hours = Math.floor(s / 3600) % 24;
    const minutes = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  },

  speedRatio(interval) {
    const i = parseInt(interval, 10);
    return i > 0 ? 500 / i : 1;
  },
};
