const TrainTracker = {
  trains: {},       // headcode -> { descr, berth, location }
  signals: {},      // signalId -> state ("danger", "caution", "proceed", etc.)
  tableBody: null,
  countEl: null,
  noTrainsEl: null,

  init() {
    this.tableBody = document.getElementById('trains-list');
    this.countEl = document.getElementById('tab-trains');
    this.noTrainsEl = document.getElementById('no-trains-message');
  },

  handleMessage(msg) {
    if (!msg || !msg.data) return;
    switch (msg.type) {
      case 'CA_MSG':
        this._stepTrain(msg.data);
        break;
      case 'CB_MSG':
        this._cancelTrain(msg.data);
        break;
      case 'CC_MSG':
        this._interposeTrain(msg.data);
        break;
      case 'SG_MSG':
        this._updateSignal(msg.data);
        break;
      case 'train_location':
        this._updateLocation(msg.data);
        break;
    }
  },

  _stepTrain(data) {
    const descr = (data.descr || '').trim();
    if (!descr) return;
    const existing = this.trains[descr] || {};
    this.trains[descr] = {
      descr,
      berth: data.to || '',
      from: data.from || '',
      location: existing.location || '',
    };
    this.render();
  },

  _cancelTrain(data) {
    const descr = (data.descr || '').trim();
    if (!descr) return;
    delete this.trains[descr];
    this.render();
  },

  _interposeTrain(data) {
    const descr = (data.descr || '').trim();
    if (!descr) return;
    const existing = this.trains[descr] || {};
    this.trains[descr] = {
      descr,
      berth: data.to || '',
      from: '',
      location: existing.location || '',
    };
    this.render();
  },

  _updateSignal(data) {
    if (data.obj_type === 'signal' && data.obj_id) {
      this.signals[data.obj_id] = data.new_state != null ? String(data.new_state) : '';
    }
  },

  _updateLocation(data) {
    const descr = (data.headcode || data.descr || '').trim();
    if (!descr) return;
    console.log('[TrainTracker] train_location:', descr, 'location:', data.location);
    if (this.trains[descr]) {
      this.trains[descr].location = data.location || '';
    } else {
      // Train location arrived before TD message — create entry
      this.trains[descr] = {
        descr,
        berth: '',
        from: '',
        location: data.location || '',
      };
    }
    this.render();
  },

  _getStatus(train) {
    const berth = train.berth;
    if (!berth) return { text: '', atSignal: false };
    // Check if the berth matches a signal at danger
    const state = this.signals[berth];
    if (state === 'danger' || state === '0' || state === 0) {
      return { text: `At signal ${berth}`, atSignal: true };
    }
    return { text: berth, atSignal: false };
  },

  render() {
    const entries = Object.values(this.trains);

    if (this.countEl) {
      this.countEl.textContent = `Trains Mobiles (${entries.length})`;
    }

    entries.sort((a, b) => a.descr.localeCompare(b.descr));

    if (entries.length === 0) {
      if (this.noTrainsEl) this.noTrainsEl.classList.remove('hidden');
      if (this.tableBody) this.tableBody.innerHTML = '';
      return;
    }

    if (this.noTrainsEl) this.noTrainsEl.classList.add('hidden');

    if (this.tableBody) {
      this.tableBody.innerHTML = entries.map((t) => {
        const status = this._getStatus(t);
        const track = t.location || t.berth || '';
        const statusText = status.text || '';
        const signalClass = status.atSignal ? ' class="at-signal"' : '';
        return `<tr><td class="col-headcode">${this._esc(t.descr)}</td><td class="col-track">${this._esc(track)}</td><td class="col-status"${signalClass}>${this._esc(statusText)}</td></tr>`;
      }).join('');
    }
  },

  // Full reset — called on disconnect to dump all state
  reset() {
    this.trains = {};
    this.signals = {};
    this.render();
  },

  _esc(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },
};
