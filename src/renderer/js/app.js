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
  });

  window.simsigAPI.phone.onCallsUpdate((calls) => {
    PhoneCallsUI.update(calls);
  });

  // Signal commands
  document.getElementById('all-danger-btn').addEventListener('click', async () => {
    const count = await window.simsigAPI.commands.allSignalsToDanger();
    console.log(`Sent bpull for ${count} signals`);
  });

  // Open message log window
  document.getElementById('msglog-btn').addEventListener('click', () => {
    window.simsigAPI.commands.openMessageLog();
  });
});
