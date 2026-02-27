const MessageFeed = {
  feedLog: null,
  feedFilter: null,
  feedClear: null,
  maxEntries: 1000,
  autoScroll: true,
  currentFilter: 'all',

  init() {
    this.feedLog = document.getElementById('feed-log');
    this.feedFilter = document.getElementById('feed-filter');
    this.feedClear = document.getElementById('feed-clear');

    this.feedFilter.addEventListener('change', () => {
      this.currentFilter = this.feedFilter.value;
      this.applyFilter();
    });

    this.feedClear.addEventListener('click', () => {
      this.clear();
    });

    this.feedLog.addEventListener('scroll', () => {
      const { scrollTop, scrollHeight, clientHeight } = this.feedLog;
      this.autoScroll = scrollHeight - scrollTop - clientHeight < 30;
    });
  },

  handleMessage(msg) {
    const entry = document.createElement('div');
    entry.className = 'feed-entry';
    entry.dataset.type = msg.type;

    const time = document.createElement('span');
    time.className = 'msg-time';
    const now = new Date();
    time.textContent = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

    const typeBadge = document.createElement('span');
    typeBadge.className = `msg-type ${msg.type}`;
    typeBadge.textContent = MessageFeed.formatTypeName(msg.type);

    const body = document.createElement('span');
    body.className = 'msg-body';
    body.textContent = MessageFeed.formatBody(msg);

    entry.appendChild(time);
    entry.appendChild(typeBadge);
    entry.appendChild(body);

    // Apply current filter
    if (MessageFeed.currentFilter !== 'all' && msg.type !== MessageFeed.currentFilter) {
      entry.style.display = 'none';
    }

    MessageFeed.feedLog.appendChild(entry);

    // Cap entries
    while (MessageFeed.feedLog.children.length > MessageFeed.maxEntries) {
      MessageFeed.feedLog.removeChild(MessageFeed.feedLog.firstChild);
    }

    if (MessageFeed.autoScroll) {
      MessageFeed.feedLog.scrollTop = MessageFeed.feedLog.scrollHeight;
    }
  },

  formatTypeName(type) {
    const names = {
      CA_MSG: 'STEP',
      CB_MSG: 'CANCEL',
      CC_MSG: 'INTERPOSE',
      SG_MSG: 'SIGNAL',
      train_location: 'LOCATION',
      train_delay: 'DELAY',
      clock_msg: 'CLOCK',
      unknown: 'UNKNOWN',
      error: 'ERROR',
    };
    return names[type] || type;
  },

  formatBody(msg) {
    const d = msg.data;
    if (!d) return JSON.stringify(msg);

    switch (msg.type) {
      case 'CA_MSG':
        return `${d.descr} : ${d.from} -> ${d.to}`;
      case 'CB_MSG':
        return `${d.descr} cancelled from ${d.from}`;
      case 'CC_MSG':
        return `${d.descr} interposed at ${d.to}`;
      case 'SG_MSG':
        return MessageFeed.formatSignalling(d);
      case 'train_location':
        return `${d.headcode || d.descr || '????'} at ${d.location || '?'}`;
      case 'train_delay':
        return `${d.headcode || d.descr || '????'} delay: ${d.delay || 0}s`;
      case 'clock_msg':
        return `Time: ${TimeUtils.formatSecondsFromMidnight(d.clock)} Speed: ${TimeUtils.speedRatio(d.interval)}x${d.paused ? ' PAUSED' : ''}`;
      default:
        return JSON.stringify(d).substring(0, 200);
    }
  },

  formatSignalling(d) {
    const parts = [];
    if (d.obj_type) parts.push(d.obj_type);
    if (d.obj_id) parts.push(d.obj_id);
    if (d.new_state != null) parts.push(`state=${d.new_state}`);
    return parts.join(' ') || JSON.stringify(d).substring(0, 200);
  },

  applyFilter() {
    const entries = this.feedLog.querySelectorAll('.feed-entry');
    entries.forEach((entry) => {
      if (this.currentFilter === 'all' || entry.dataset.type === this.currentFilter) {
        entry.style.display = '';
      } else {
        entry.style.display = 'none';
      }
    });
  },

  clear() {
    this.feedLog.innerHTML = '';
  },

  // Full reset — called on disconnect to dump all state
  reset() {
    this.clear();
    this.currentFilter = 'all';
    this.feedFilter.value = 'all';
  },
};
