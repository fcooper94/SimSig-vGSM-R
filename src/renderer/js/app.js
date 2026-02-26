document.addEventListener('DOMContentLoaded', async () => {
  // Initialize all UI modules
  ConnectionUI.init();
  SettingsUI.init();
  await PTTUI.init();
  AudioPipeline.init();
  PhoneCallsUI.init();

  // Register event listeners from main process
  window.simsigAPI.connection.onStatusChange((status) => {
    ConnectionUI.setStatus(status);
  });

  window.simsigAPI.clock.onUpdate((data) => {
    ConnectionUI.handleClockUpdate(data);
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

  // Auto-populate panel name from SimSig window title
  window.simsigAPI.sim.onName((name) => {
    document.getElementById('panel-name-tab').textContent = name;
  });

  // Emergency button — shows confirmation modal
  document.getElementById('emrg-btn').addEventListener('click', () => {
    document.getElementById('confirm-modal').classList.remove('hidden');
  });

  document.getElementById('confirm-yes').addEventListener('click', async () => {
    document.getElementById('confirm-modal').classList.add('hidden');
    const count = await window.simsigAPI.commands.allSignalsToDanger();
    console.log(`Sent bpull for ${count} signals`);
  });

  document.getElementById('confirm-no').addEventListener('click', () => {
    document.getElementById('confirm-modal').classList.add('hidden');
  });

  // Open message log window
  document.getElementById('msglog-btn').addEventListener('click', () => {
    window.simsigAPI.commands.openMessageLog();
  });

  // msglog-btn handler is above; panel name is set via sim.onName listener
});
