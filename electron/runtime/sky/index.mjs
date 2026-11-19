// Local protocol-compatible client. The Windows implementation lives in Electron.
const call = async (method, input = {}) => {
  if (!globalThis.nodeRepl?.rpc) throw new Error('Computer Use requires the local Node runtime');
  const result = await globalThis.nodeRepl.rpc('computer', { method, params: input });
  if (method === 'get_window_state') for (const screenshot of result.screenshots ?? []) {
    await globalThis.nodeRepl.emitImage(screenshot.url);
  }
  return result;
};
export const sky = Object.freeze({
  target: 'windows',
  list_windows: () => call('list_windows'),
  list_apps: () => call('list_apps'),
  get_window: input => call('get_window', input),
  launch_app: input => call('launch_app', input),
  get_window_state: input => call('get_window_state', input),
  click: input => call('click', input),
  press_key: input => call('press_key', input),
  type_text: input => call('type_text', input),
  scroll: input => call('scroll', input),
  set_value: input => call('set_value', input),
  drag: input => call('drag', input),
  perform_secondary_action: input => call('perform_secondary_action', input),
  activate_window: input => call('activate_window', input),
});
