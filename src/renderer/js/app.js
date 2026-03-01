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
      MessageFeed.reset();
      // Reset panel name
      document.getElementById('panel-name-tab').textContent = '-';
      document.getElementById('panel-subtitle').textContent = '';
      // Hide paused overlay
      document.getElementById('paused-overlay').classList.add('hidden');
      // Clear phonebook cache so it re-fetches on next connect
      phonebookContacts = [];
      phonebookList.innerHTML = '';
      phonebookStatus.textContent = '';
    }
  });

  window.simsigAPI.clock.onUpdate((data) => {
    if (!ConnectionUI.isConnected && ConnectionUI.indicator.className !== 'no-gateway') return;
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
  });

  window.simsigAPI.phone.onCallsUpdate((calls) => {
    if (!ConnectionUI.isConnected && ConnectionUI.indicator.className !== 'no-gateway') return;
    PhoneCallsUI.update(calls);
  });

  window.simsigAPI.phone.onDriverHungUp(() => {
    if (!ConnectionUI.isConnected && ConnectionUI.indicator.className !== 'no-gateway') return;
    if (PhoneCallsUI.inCall) {
      // If we already sent a reply, the dialog closing is expected (not a driver hang-up)
      if (PhoneCallsUI._replySent) return;
      console.log('[App] Driver hung up — ending call');
      PhoneCallsUI.hangUp();
    }
  });

  // Feed STOMP messages to TrainTracker and MessageFeed
  window.simsigAPI.messages.onMessage((msg) => {
    if (!ConnectionUI.isConnected && ConnectionUI.indicator.className !== 'no-gateway') return;
    TrainTracker.handleMessage(msg);
    MessageFeed.handleMessage(msg);
  });

  // Auto-populate panel name and subtitle from SimSig window title
  window.simsigAPI.sim.onName((name) => {
    const ascIdx = name.toUpperCase().indexOf('ASC');
    const trimmed = ascIdx !== -1 ? name.substring(0, ascIdx + 3).trim() : name;
    document.getElementById('panel-name-tab').textContent = trimmed;
    // Show full name in subtitle row
    document.getElementById('panel-subtitle').textContent = name;
  });

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

  tabs.incoming.tab.addEventListener('click', () => switchTab('incoming'));
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

  // Phone Book view (declared here; also cleared on disconnect above)
  const phonebookList = document.getElementById('phonebook-list');
  const phonebookStatus = document.getElementById('phonebook-status');
  let phonebookContacts = [];

  async function loadPhoneBook() {
    phonebookStatus.textContent = '';
    phonebookList.innerHTML = '<div class="phonebook-loading">Loading contacts...</div>';
    const result = await window.simsigAPI.phone.readPhoneBook();
    if (result.error) {
      phonebookList.innerHTML = '<div class="phonebook-loading">Could not load contacts</div>';
      phonebookStatus.textContent = result.error;
      return;
    }
    phonebookContacts = result.contacts || [];
    if (phonebookContacts.length === 0) {
      phonebookList.innerHTML = '<div class="phonebook-loading">No contacts available. Open a sim in SimSig first.</div>';
      return;
    }
    phonebookStatus.textContent = '';
    phonebookList.innerHTML = '';
    phonebookContacts.forEach((name, idx) => {
      const row = document.createElement('div');
      row.className = 'phonebook-item';

      const avatar = document.createElement('div');
      avatar.className = 'phonebook-avatar';
      avatar.textContent = name.charAt(0).toUpperCase();
      row.appendChild(avatar);

      const label = document.createElement('div');
      label.className = 'phonebook-name';
      label.textContent = name;
      row.appendChild(label);

      const dialIcon = document.createElement('div');
      dialIcon.className = 'phonebook-dial-icon';
      dialIcon.innerHTML = '&#128222;';
      row.appendChild(dialIcon);

      row.addEventListener('click', async () => {
        if (!ConnectionUI.isConnected) {
          phonebookStatus.textContent = 'Cannot dial while disconnected';
          return;
        }
        if (PhoneCallsUI.inCall || PhoneCallsUI._outgoingCall || PhoneCallsUI._dialingActive) {
          phonebookStatus.textContent = 'Cannot dial while in a call';
          return;
        }
        // Browser: forward dial action to host (host runs the full outgoing call flow)
        if (window.simsigAPI._isBrowser) {
          window.simsigAPI.phone.remoteAction({ type: 'dial', index: idx, name });
          return;
        }
        row.classList.add('dialing');
        PhoneCallsUI.showDialingNotification(name);
        const res = await window.simsigAPI.phone.dialPhoneBook(idx);
        if (res.error) {
          row.classList.remove('dialing');
          PhoneCallsUI.stopDialing();
          phonebookStatus.textContent = res.error;
        } else {
          // Poll SimSig's Place Call dialog until connected
          const pollForConnection = async () => {
            // Minimum ring time of 3 seconds before first check
            await new Promise((r) => setTimeout(r, 3000));
            for (let i = 0; i < 30; i++) {
              if (!PhoneCallsUI._dialingActive) return; // user cancelled
              const status = await window.simsigAPI.phone.placeCallStatus(name);
              if (status.connected && status.replies && status.replies.length > 0) {
                row.classList.remove('dialing');
                PhoneCallsUI.stopDialing(true);  // keep Place Call dialog open for replies
                PhoneCallsUI.showOutgoingCallNotification(name, status.message, status.replies);
                return;
              }
              await new Promise((r) => setTimeout(r, 1000));
            }
            // Timed out — stop dialing
            row.classList.remove('dialing');
            PhoneCallsUI.stopDialing();
            phonebookStatus.textContent = 'No answer';
          };
          pollForConnection();
        }
      });
      phonebookList.appendChild(row);
    });
    // Re-apply In Call state if an outgoing call is active
    if (PhoneCallsUI._outgoingCall && PhoneCallsUI._outgoingContactName) {
      PhoneCallsUI._updatePhonebookInCall(PhoneCallsUI._outgoingContactName, true);
    }
  }

  document.getElementById('phonebook-btn').addEventListener('click', () => {
    switchTab('phonebook');
    // Only fetch from SimSig on first open — use cache after that
    if (phonebookContacts.length === 0) {
      loadPhoneBook();
    }
  });

  document.getElementById('phonebook-refresh').addEventListener('click', () => {
    loadPhoneBook();
  });

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
      setTimeout(() => {
        switchTab('phonebook');
        if (phonebookContacts.length === 0) loadPhoneBook();
      }, 100);
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
