document.addEventListener('DOMContentLoaded', async () => {
  // Apply saved theme immediately to prevent flash of light mode
  const allSettings = await window.simsigAPI.settings.getAll();
  if (allSettings.theme === 'dark') document.body.classList.add('dark-mode');

  // Initialize all UI modules synchronously first
  ConnectionUI.init();
  SettingsUI.init();
  AudioPipeline.init();
  PhoneCallsUI.init();
  TrainTracker.init();
  MessageFeed.init();

  // Register ALL event listeners BEFORE any async work.
  // The WebSocket initial state sync fires as soon as the connection opens,
  // so listeners must be in place before we yield to the event loop (await).

  // Hide init overlay once pause/unpause sync completes
  window.simsigAPI.sim.onReady(() => {
    const initOverlay = document.getElementById('init-overlay');
    if (initOverlay) initOverlay.classList.add('hidden');
    PhoneCallsUI.initReady = true;
    // Start ringing if calls arrived during init
    if (PhoneCallsUI.calls.length > 0 && !PhoneCallsUI.inCall) {
      PhoneCallsUI.startRinging();
    }
  });

  // Register event listeners from main process
  window.simsigAPI.connection.onStatusChange((status) => {
    ConnectionUI.setStatus(status);

    // On disconnect, dump all data from every UI module
    const statusStr = typeof status === 'object' ? status.status : status;
    if (statusStr === 'disconnected') {
      PhoneCallsUI.reset();
      TrainTracker.reset();
      AlertsFeed.clear();
      MessageFeed.reset();
      // Reset panel name
      document.getElementById('panel-name-tab').textContent = '-';
      document.getElementById('panel-subtitle').textContent = '';
      // Hide paused overlay
      document.getElementById('paused-overlay').classList.add('hidden');
      // Clear phonebook cache and hide overlay
      phonebookContacts = [];
      _globalPeers = [];
      phonebookList.innerHTML = '';
      phonebookStatus.textContent = '';
      phonebookOverlay.classList.add('hidden');
    }
  });

  window.simsigAPI.clock.onUpdate((data) => {
    const overlay = document.getElementById('paused-overlay');
    if (data.paused) {
      overlay.classList.remove('hidden');
      PhoneCallsUI.muteAll();
    } else {
      overlay.classList.add('hidden');
      PhoneCallsUI.resumeRinging();
    }
    // Track game time for chat message timestamps
    if (data.formatted) PhoneCallsUI.gameTime = data.formatted;
    // Feed clock seconds to AlertsFeed for session validation
    if (data.clockSeconds != null) AlertsFeed.onClockUpdate(data.clockSeconds);
  });

  window.simsigAPI.phone.onCallsUpdate((calls) => {
    AlertsFeed.pruneFromCalls(calls);
    PhoneCallsUI.update(calls);
  });

  window.simsigAPI.phone.onDriverHungUp(() => {
    if (PhoneCallsUI.inCall) {
      // If we already sent a reply, the dialog closing is expected (not a driver hang-up)
      if (PhoneCallsUI._replySent) return;
      console.log('[App] Driver hung up — ending call');
      PhoneCallsUI.hangUp();
    }
  });

  // Feed STOMP messages to TrainTracker and MessageFeed
  AlertsFeed.init();
  window.simsigAPI.messages.onMessage((msg) => {
    if (!ConnectionUI.isConnected && ConnectionUI.indicator.className !== 'no-gateway') return;
    TrainTracker.handleMessage(msg);
    MessageFeed.handleMessage(msg);
    // Feed berth step messages to AlertsFeed for movement detection
    // (removes trains from "waiting at red" when they move)
    if (msg.type === 'CA_MSG' && msg.data?.descr) {
      AlertsFeed.onTrainMovement(msg.data.descr);
    }
  });

  // Chatterbox install progress overlay
  if (window.simsigAPI.tts.onInstallProgress) {
    window.simsigAPI.tts.onInstallProgress((data) => {
      const overlay = document.getElementById('chatterbox-install-overlay');
      const detail = document.getElementById('chatterbox-install-detail');
      const fill = document.getElementById('chatterbox-progress-fill');
      if (!overlay) return;
      if (data.percent < 100) {
        overlay.classList.remove('hidden');
        detail.textContent = data.detail || data.stage;
        fill.style.width = data.percent + '%';
      } else {
        fill.style.width = '100%';
        detail.textContent = 'Ready!';
        setTimeout(() => overlay.classList.add('hidden'), 1000);
      }
    });
  }

  // Failure dialog auto-suppression — show dismissed failures in alerts feed
  window.simsigAPI.sim.onFailure((dismissed) => {
    AlertsFeed.addFailure(dismissed);
  });

  // SimSig message log — feed relevant lines into alerts feed
  window.simsigAPI.sim.onMessageLog((lines) => {
    AlertsFeed.addMessageLogLines(lines);
  });

  // Player peer discovery updates
  window.simsigAPI.player.onPeersUpdate((peers) => {
    _globalPeers = peers;
    console.log(`[Players] Peers updated — ${peers.length} online: ${peers.map(p => p.panel).join(', ') || '(none)'}`);
    if (_phonebookTab === 'global' && !phonebookOverlay.classList.contains('hidden')) {
      _renderPhonebook();
    }
  });

  // Player call events
  window.simsigAPI.player.onIncomingCall((data) => {
    PhoneCallsUI.handleIncomingPlayerCall(data.panel, data.id);
  });
  window.simsigAPI.player.onCallAnswered((data) => {
    PhoneCallsUI.handlePlayerCallAnswered(data);
  });
  window.simsigAPI.player.onCallEnded(() => {
    PhoneCallsUI.handlePlayerCallEnded();
  });
  window.simsigAPI.player.onWebRTCSignal((data) => {
    PhoneCallsUI.handleWebRTCSignal(data);
  });
  window.simsigAPI.player.onCallRejected((reason) => {
    PhoneCallsUI.handlePlayerCallRejected(reason);
  });

  // Auto-populate panel name and subtitle from SimSig window title
  window.simsigAPI.sim.onName((name) => {
    const ascIdx = name.toUpperCase().indexOf('ASC');
    const trimmed = ascIdx !== -1 ? name.substring(0, ascIdx + 3).trim() : name;
    document.getElementById('panel-name-tab').textContent = trimmed;
    // Show full name in subtitle row
    document.getElementById('panel-subtitle').textContent = name;
    // Keep PhoneCallsUI in sync so Route Control lookup works
    PhoneCallsUI.currentPanelName = name;
    // Restore saved alerts state (waited trains, failures) for this sim
    AlertsFeed.restoreState();
  });

  // Show our workstation panel name when detected from message log
  if (window.simsigAPI.player.onOurPanel) {
    window.simsigAPI.player.onOurPanel((panelName) => {
      const initials = document.getElementById('panel-name-tab').dataset.initials || '';
      document.getElementById('panel-subtitle').textContent = `${panelName}${initials ? ' (' + initials + ')' : ''}`;
    });
  }

  // Now do async initialization (PTTUI needs settings from main process)
  await PTTUI.init();

  // Tab switching — left panel views (comms chat stays always-visible in right panel)
  const tabs = {
    incoming:  { tab: document.getElementById('tab-incoming'), view: document.getElementById('phone-calls') },
    trains:    { tab: document.getElementById('tab-trains'),   view: document.getElementById('trains-mobiles') },
    log:       { tab: document.getElementById('tab-log'),      view: document.getElementById('message-log') },
    emergency: { tab: null,                                    view: document.getElementById('emergency-view') },
    phonebook: { tab: null,                                    view: document.getElementById('phonebook-view') },
  };

  function switchTab(name) {
    for (const [key, { tab, view }] of Object.entries(tabs)) {
      if (key === name) {
        view.classList.add('active-view');
        if (tab) tab.classList.add('active');
      } else {
        view.classList.remove('active-view');
        if (tab) tab.classList.remove('active');
      }
    }
  }

  tabs.incoming.tab.addEventListener('click', () => {
    if (typeof PhoneCallsUI !== 'undefined' && PhoneCallsUI._playerCall) {
      PhoneCallsUI.hangUpPlayerCall();
      return;
    }
    switchTab('incoming');
  });
  tabs.trains.tab.addEventListener('click', () => switchTab('trains'));
  tabs.log.tab.addEventListener('click', () => switchTab('log'));

  // Setting toolbar button opens settings modal
  const settingsToolbarBtn = document.getElementById('settings-toolbar-btn');
  if (settingsToolbarBtn) {
    settingsToolbarBtn.addEventListener('click', () => SettingsUI.open());
  }

  // Emergency view
  const emrgFeedback = document.getElementById('emrg-feedback');
  const emrgConfirmModal = document.getElementById('emrg-confirm-modal');

  document.getElementById('emrg-btn').addEventListener('click', () => {
    emrgFeedback.textContent = '';
    switchTab('emergency');
  });

  document.getElementById('emrg-stop-all').addEventListener('click', () => {
    emrgConfirmModal.classList.remove('hidden');
  });

  document.getElementById('emrg-confirm-yes').addEventListener('click', async () => {
    emrgConfirmModal.classList.add('hidden');
    const count = await window.simsigAPI.commands.allSignalsToDanger();
    emrgFeedback.textContent = `${count} signals set to danger`;
    setTimeout(() => {
      switchTab('incoming');
    }, 2000);
  });

  document.getElementById('emrg-confirm-no').addEventListener('click', () => {
    emrgConfirmModal.classList.add('hidden');
  });

  // Phone Book overlay
  const phonebookOverlay = document.getElementById('phonebook-overlay');
  const phonebookList = document.getElementById('phonebook-list');
  const phonebookStatus = document.getElementById('phonebook-status');
  const phonebookCount = document.getElementById('phonebook-count');
  const pbDialBtn = document.getElementById('pb-dial-btn');
  const pbCloseBtn = document.getElementById('pb-close-btn');
  const pbTabGlobal = document.getElementById('pb-tab-global');
  const pbTabLocal = document.getElementById('pb-tab-local');
  let phonebookContacts = [];
  let _selectedPhonebookIndex = -1;
  let _phonebookTab = 'local'; // 'local' or 'global'
  let _globalPeers = []; // discovered player peers

  // Generate a deterministic fake GSM-R number from a contact name
  function _gsmrNumber(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
    }
    // 8-digit number starting with 74
    const suffix = Math.abs(hash) % 1000000;
    return '74' + String(suffix).padStart(6, '0');
  }

  function _renderPhonebook() {
    phonebookList.innerHTML = '';
    phonebookStatus.textContent = '';
    _selectedPhonebookIndex = -1;

    if (_phonebookTab === 'global') {
      if (_globalPeers.length === 0) {
        phonebookCount.textContent = 'No other players detected on this network.';
        return;
      }
      phonebookCount.textContent = `${_globalPeers.length} player${_globalPeers.length !== 1 ? 's' : ''} online.`;

      _globalPeers.forEach((peer, idx) => {
        const tr = document.createElement('tr');
        tr.className = 'pb-row pb-player';
        const tdName = document.createElement('td');
        tdName.className = 'pb-cell-name';
        tdName.textContent = peer.panel || 'Unknown Panel';
        tr.appendChild(tdName);
        const tdStatus = document.createElement('td');
        tdStatus.className = 'pb-cell-number pb-online';
        tdStatus.textContent = 'Online';
        tr.appendChild(tdStatus);
        tr.addEventListener('click', () => {
          _selectedPhonebookIndex = idx;
          phonebookList.querySelectorAll('.pb-row').forEach((r, i) => {
            r.classList.toggle('pb-selected', i === idx);
          });
        });
        phonebookList.appendChild(tr);
      });
      return;
    }

    const entries = []; // { name, number, isRouteControl, contactIndex }

    // Route Control entry at top
    const routeControl = PhoneCallsUI.getRouteControl();
    if (routeControl) {
      entries.push({
        name: `Route Control (${routeControl})`,
        number: '74000001',
        isRouteControl: true,
        contactIndex: -1
      });
    }

    phonebookContacts.forEach((name, idx) => {
      entries.push({
        name,
        number: _gsmrNumber(name),
        isRouteControl: false,
        contactIndex: idx
      });
    });

    if (entries.length === 0) {
      phonebookCount.textContent = 'No outside contacts available for this simulation.';
      return;
    }

    phonebookCount.textContent = `${entries.length} item${entries.length !== 1 ? 's' : ''} in local phone book.`;

    entries.forEach((entry, idx) => {
      const tr = document.createElement('tr');
      tr.className = 'pb-row';
      if (entry.isRouteControl) tr.classList.add('pb-route-control');

      const tdName = document.createElement('td');
      tdName.className = 'pb-cell-name';
      tdName.textContent = entry.name;
      tr.appendChild(tdName);

      const tdNum = document.createElement('td');
      tdNum.className = 'pb-cell-number';
      tdNum.textContent = entry.number;
      tr.appendChild(tdNum);

      tr.addEventListener('click', () => {
        _selectedPhonebookIndex = idx;
        phonebookList.querySelectorAll('.pb-row').forEach((r, i) => {
          r.classList.toggle('pb-selected', i === idx);
        });
      });

      phonebookList.appendChild(tr);
    });

    // Update Route Control enabled/disabled state
    if (routeControl) {
      const updateRcState = () => {
        const rcRow = phonebookList.querySelector('.pb-route-control');
        if (!rcRow) return;
        const hasFailures = typeof AlertsFeed !== 'undefined' && AlertsFeed.getActiveFailures().length > 0;
        const hasWrongRoute = !!PhoneCallsUI._lastRouteQuery;
        rcRow.classList.toggle('disabled', !hasFailures && !hasWrongRoute);
        rcRow.title = (hasFailures || hasWrongRoute) ? '' : 'Nothing to report';
      };
      updateRcState();
      AlertsFeed._onRenderCallback = updateRcState;
      PhoneCallsUI._updateRcState = updateRcState;
    }
  }

  function _getPhonebookEntries() {
    const entries = [];
    const routeControl = PhoneCallsUI.getRouteControl();
    if (routeControl) {
      entries.push({ name: `Route Control (${routeControl})`, isRouteControl: true, contactIndex: -1 });
    }
    phonebookContacts.forEach((name, idx) => {
      entries.push({ name, isRouteControl: false, contactIndex: idx });
    });
    return entries;
  }

  function _dialSelectedContact() {
    if (_selectedPhonebookIndex < 0) {
      phonebookStatus.textContent = 'Select a contact first';
      return;
    }

    if (!ConnectionUI.isConnected) {
      phonebookStatus.textContent = 'Cannot dial while disconnected';
      return;
    }
    if (PhoneCallsUI.inCall || PhoneCallsUI._outgoingCall || PhoneCallsUI._dialingActive || PhoneCallsUI._playerCall) {
      phonebookStatus.textContent = 'Cannot dial while in a call';
      return;
    }

    // Global tab — dial a player peer
    if (_phonebookTab === 'global') {
      const peer = _globalPeers[_selectedPhonebookIndex];
      if (!peer) return;
      phonebookOverlay.classList.add('hidden');
      PhoneCallsUI.dialPlayer(peer);
      return;
    }

    const entries = _getPhonebookEntries();
    const entry = entries[_selectedPhonebookIndex];
    if (!entry) return;

    if (entry.isRouteControl) {
      const hasFailures = typeof AlertsFeed !== 'undefined' && AlertsFeed.getActiveFailures().length > 0;
      const hasWrongRoute = !!PhoneCallsUI._lastRouteQuery;
      if (!hasFailures && !hasWrongRoute) {
        phonebookStatus.textContent = 'Nothing to report';
        return;
      }
      PhoneCallsUI.dialRouteControl();
      return;
    }

    // Browser: forward dial action to host
    if (window.simsigAPI._isBrowser) {
      window.simsigAPI.phone.remoteAction({ type: 'dial', index: entry.contactIndex, name: entry.name });
      return;
    }

    const selectedRow = phonebookList.querySelectorAll('.pb-row')[_selectedPhonebookIndex];
    if (selectedRow) selectedRow.classList.add('pb-dialing');
    PhoneCallsUI.showDialingNotification(entry.name);

    (async () => {
      const res = await window.simsigAPI.phone.dialPhoneBook(entry.contactIndex);
      if (res.error) {
        if (selectedRow) selectedRow.classList.remove('pb-dialing');
        PhoneCallsUI.stopDialing();
        phonebookStatus.textContent = res.error;
      } else {
        // Poll SimSig's Place Call dialog until connected
        await new Promise((r) => setTimeout(r, 3000));
        for (let i = 0; i < 30; i++) {
          if (!PhoneCallsUI._dialingActive) return;
          const status = await window.simsigAPI.phone.placeCallStatus(entry.name);
          if (status.connected && status.replies && status.replies.length > 0) {
            if (selectedRow) selectedRow.classList.remove('pb-dialing');
            PhoneCallsUI.stopDialing(true);
            PhoneCallsUI.showOutgoingCallNotification(entry.name, status.message, status.replies);
            return;
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
        if (selectedRow) selectedRow.classList.remove('pb-dialing');
        PhoneCallsUI.stopDialing();
        phonebookStatus.textContent = 'No answer';
      }
    })();
  }

  async function loadPhoneBook() {
    phonebookStatus.textContent = '';
    phonebookList.innerHTML = '<tr><td colspan="2" class="pb-loading">Loading contacts...</td></tr>';
    const result = await window.simsigAPI.phone.readPhoneBook();
    if (result.error) {
      if (phonebookContacts.length > 0) {
        phonebookStatus.textContent = '';
      } else {
        phonebookList.innerHTML = '<tr><td colspan="2" class="pb-loading">Could not load contacts</td></tr>';
        phonebookStatus.textContent = result.error;
        return;
      }
    } else {
      const freshContacts = result.contacts || [];
      if (freshContacts.length === 0 && phonebookContacts.length > 0) {
        // SimSig may be in background — keep cached contacts
      } else {
        phonebookContacts = freshContacts;
      }
    }
    _renderPhonebook();
  }

  function showPhonebook() {
    phonebookOverlay.classList.remove('hidden');
    if (phonebookContacts.length === 0) {
      loadPhoneBook();
    } else {
      _renderPhonebook();
    }
  }

  pbDialBtn.addEventListener('click', () => _dialSelectedContact());
  pbCloseBtn.addEventListener('click', () => phonebookOverlay.classList.add('hidden'));

  const pbRescanBtn = document.getElementById('pb-rescan-btn');

  function _updateRescanVisibility() {
    if (pbRescanBtn) pbRescanBtn.classList.toggle('hidden', _phonebookTab !== 'global');
  }

  pbTabLocal.addEventListener('click', () => {
    if (_phonebookTab === 'local') return;
    _phonebookTab = 'local';
    pbTabLocal.classList.add('active');
    pbTabGlobal.classList.remove('active');
    _updateRescanVisibility();
    _renderPhonebook();
  });

  pbTabGlobal.addEventListener('click', () => {
    if (_phonebookTab === 'global') return;
    _phonebookTab = 'global';
    pbTabGlobal.classList.add('active');
    pbTabLocal.classList.remove('active');
    _updateRescanVisibility();
    _renderPhonebook();
  });

  if (pbRescanBtn) {
    pbRescanBtn.addEventListener('click', async () => {
      pbRescanBtn.disabled = true;
      pbRescanBtn.textContent = 'Scanning...';
      await window.simsigAPI.player.rescan();
      setTimeout(() => {
        pbRescanBtn.disabled = false;
        pbRescanBtn.textContent = '\u21BB Rescan';
      }, 2000);
    });
  }

  document.getElementById('phonebook-btn').addEventListener('click', () => {
    showPhonebook();
  });

  // Keep refresh button working if it exists
  const phonebookRefreshBtn = document.getElementById('phonebook-refresh');
  if (phonebookRefreshBtn) {
    phonebookRefreshBtn.addEventListener('click', () => loadPhoneBook());
  }

  // ── Compact Mode ──────────────────────────────────────────
  const compactToggleBtn = document.getElementById('compact-toggle-btn');
  const compactExpandBtn = document.getElementById('compact-expand-btn');
  const compactEmrgBtn = document.getElementById('compact-emrg-btn');
  const compactDialBtn = document.getElementById('compact-dial-btn');
  const compactNotification = document.getElementById('compact-notification');

  if (compactToggleBtn) {
    compactToggleBtn.addEventListener('click', () => {
      window.simsigAPI.window.toggleCompact();
    });
  }

  if (compactExpandBtn) {
    compactExpandBtn.addEventListener('click', () => {
      window.simsigAPI.window.toggleCompact();
    });
  }

  const compactEmrgPanel = document.getElementById('compact-emrg-panel');
  const compactEmrgActions = document.getElementById('compact-emrg-actions');
  const compactEmrgConfirm = document.getElementById('compact-emrg-confirm');
  const compactEmrgStopAll = document.getElementById('compact-emrg-stop-all');
  const compactEmrgCancel = document.getElementById('compact-emrg-cancel');

  function resetCompactEmrgState() {
    if (compactEmrgActions) compactEmrgActions.classList.remove('hidden');
    if (compactEmrgConfirm) compactEmrgConfirm.classList.add('hidden');
  }

  function showCompactEmrgPanel() {
    if (!compactEmrgPanel) return;
    resetCompactEmrgState();
    compactEmrgPanel.classList.remove('hidden', 'closing');
    compactEmrgPanel.style.visibility = 'hidden';
    requestAnimationFrame(async () => {
      const panelH = compactEmrgPanel.offsetHeight;
      await window.simsigAPI.window.compactResize(70 + panelH);
      compactEmrgPanel.style.visibility = '';
    });
  }

  function hideCompactEmrgPanel() {
    if (!compactEmrgPanel) return;
    compactEmrgPanel.classList.add('closing');
    compactEmrgPanel.addEventListener('animationend', () => {
      compactEmrgPanel.classList.add('hidden');
      compactEmrgPanel.classList.remove('closing');
      window.simsigAPI.window.compactResize(70);
    }, { once: true });
  }

  if (compactEmrgBtn) {
    compactEmrgBtn.addEventListener('click', () => showCompactEmrgPanel());
  }

  // "Send All Stop" → show confirmation
  if (compactEmrgStopAll) {
    compactEmrgStopAll.addEventListener('click', () => {
      if (compactEmrgActions) compactEmrgActions.classList.add('hidden');
      if (compactEmrgConfirm) compactEmrgConfirm.classList.remove('hidden');
    });
  }

  // Confirm Yes → send the command and close
  const compactEmrgConfirmYes = document.getElementById('compact-emrg-confirm-yes');
  if (compactEmrgConfirmYes) {
    compactEmrgConfirmYes.addEventListener('click', async () => {
      hideCompactEmrgPanel();
      await window.simsigAPI.commands.allSignalsToDanger();
    });
  }

  // Confirm No → go back to action list
  const compactEmrgConfirmNo = document.getElementById('compact-emrg-confirm-no');
  if (compactEmrgConfirmNo) {
    compactEmrgConfirmNo.addEventListener('click', () => {
      resetCompactEmrgState();
    });
  }

  if (compactEmrgCancel) {
    compactEmrgCancel.addEventListener('click', () => hideCompactEmrgPanel());
  }

  if (compactDialBtn) {
    compactDialBtn.addEventListener('click', () => {
      window.simsigAPI.window.toggleCompact();
      setTimeout(() => showPhonebook(), 100);
    });
  }

  if (compactNotification) {
    compactNotification.addEventListener('click', () => {
      const notifBtn = document.getElementById('notification-answer-btn');
      if (notifBtn) notifBtn.click();
    });
  }

  window.simsigAPI.window.onCompactChanged((isCompact) => {
    document.body.classList.toggle('compact-mode', isCompact);
  });

  // ── Comms Zoom ───────────────────────────────────────────────
  const commsZoomBtn = document.getElementById('comms-zoom-btn');
  const commsZoomPopup = document.getElementById('comms-zoom-popup');
  const commsZoomSlider = document.getElementById('comms-zoom-slider');
  const commsZoomMinus = document.getElementById('comms-zoom-minus');
  const commsZoomPlus = document.getElementById('comms-zoom-plus');
  const chatMessages = document.getElementById('chat-messages');

  function applyCommsZoom(size) {
    chatMessages.style.fontSize = size + 'px';
    commsZoomSlider.value = size;
  }

  commsZoomBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    commsZoomPopup.classList.toggle('hidden');
  });

  commsZoomSlider.addEventListener('input', () => {
    applyCommsZoom(parseInt(commsZoomSlider.value));
  });

  commsZoomMinus.addEventListener('click', () => {
    const val = Math.max(8, parseInt(commsZoomSlider.value) - 1);
    applyCommsZoom(val);
  });

  commsZoomPlus.addEventListener('click', () => {
    const val = Math.min(20, parseInt(commsZoomSlider.value) + 1);
    applyCommsZoom(val);
  });

  // Close popup when clicking outside
  document.addEventListener('click', (e) => {
    if (!commsZoomPopup.contains(e.target) && e.target !== commsZoomBtn) {
      commsZoomPopup.classList.add('hidden');
    }
  });

  // ── Close Confirmation (styled modal) ──────────────────────
  const confirmModal = document.getElementById('confirm-modal');
  const confirmTitle = document.getElementById('confirm-title');
  const confirmMessage = document.getElementById('confirm-message');
  const confirmYes = document.getElementById('confirm-yes');
  const confirmNo = document.getElementById('confirm-no');

  window.simsigAPI.window.onConfirmClose(() => {
    confirmTitle.textContent = 'Close Application';
    confirmMessage.textContent = 'Are you sure you want to close SimSig VGSM-R?';
    confirmModal.classList.remove('hidden');

    const onYes = () => {
      confirmModal.classList.add('hidden');
      cleanup();
      window.simsigAPI.window.confirmCloseReply(true);
    };
    const onNo = () => {
      confirmModal.classList.add('hidden');
      cleanup();
      window.simsigAPI.window.confirmCloseReply(false);
    };
    const cleanup = () => {
      confirmYes.removeEventListener('click', onYes);
      confirmNo.removeEventListener('click', onNo);
    };
    confirmYes.addEventListener('click', onYes);
    confirmNo.addEventListener('click', onNo);
  });

  // ── Test Call Simulator (Ctrl+Shift+T) ────────────────────
  const testCallModal = document.getElementById('test-call-modal');
  if (testCallModal) {
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyT') {
        e.preventDefault();
        testCallModal.classList.toggle('hidden');
      }
    });
    testCallModal.querySelectorAll('.test-call-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        testCallModal.classList.add('hidden');
        PhoneCallsUI.simulateCall(btn.dataset.type);
      });
    });
    testCallModal.querySelectorAll('.test-alert-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        testCallModal.classList.add('hidden');
        AlertsFeed.simulateAlert(btn.dataset.alert);
      });
    });
    document.getElementById('test-call-cancel').addEventListener('click', () => {
      testCallModal.classList.add('hidden');
    });
  }

  // Show browser overlay if web server is already running (auto-started)
  // Done last so a failure here can't block event listener registration
  try {
    if (window.simsigAPI.web) {
      const webSettings = await window.simsigAPI.settings.getAll();
      if (webSettings.web?.enabled) {
        const port = webSettings.web.port || 3000;
        const result = await window.simsigAPI.web.start(port);
        document.getElementById('browser-overlay-url').textContent = `${result.ip || 'localhost'}:${port}`;
        document.getElementById('browser-overlay').classList.remove('hidden');
      }
    }
  } catch (err) {
    console.warn('[App] Failed to show browser overlay:', err);
  }

});
