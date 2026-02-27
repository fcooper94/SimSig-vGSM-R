document.addEventListener('DOMContentLoaded', async () => {
  // Initialize all UI modules
  ConnectionUI.init();
  SettingsUI.init();
  await PTTUI.init();
  AudioPipeline.init();
  PhoneCallsUI.init();
  TrainTracker.init();
  MessageFeed.init();

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
  });

  window.simsigAPI.phone.onCallsUpdate((calls) => {
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
  window.simsigAPI.messages.onMessage((msg) => {
    TrainTracker.handleMessage(msg);
    MessageFeed.handleMessage(msg);
  });

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

  // Auto-populate panel name and subtitle from SimSig window title
  window.simsigAPI.sim.onName((name) => {
    const ascIdx = name.toUpperCase().indexOf('ASC');
    const trimmed = ascIdx !== -1 ? name.substring(0, ascIdx + 3).trim() : name;
    document.getElementById('panel-name-tab').textContent = trimmed;
    // Show full name in subtitle row
    document.getElementById('panel-subtitle').textContent = name;
  });

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

  // Phone Book view
  const phonebookList = document.getElementById('phonebook-list');
  const phonebookStatus = document.getElementById('phonebook-status');
  let phonebookContacts = [];

  async function loadPhoneBook() {
    phonebookStatus.textContent = 'Loading...';
    phonebookList.innerHTML = '';
    const result = await window.simsigAPI.phone.readPhoneBook();
    if (result.error) {
      phonebookStatus.textContent = result.error;
      return;
    }
    phonebookContacts = result.contacts || [];
    if (phonebookContacts.length === 0) {
      phonebookStatus.textContent = 'No contacts found';
      return;
    }
    phonebookStatus.textContent = '';
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
        if (PhoneCallsUI.inCall || PhoneCallsUI._outgoingCall || PhoneCallsUI._dialingActive) {
          phonebookStatus.textContent = 'Cannot dial while in a call';
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
              const status = await window.simsigAPI.phone.placeCallStatus();
              if (status.connected) {
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

});
