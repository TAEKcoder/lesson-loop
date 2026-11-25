// A project may discover releases automatically, but applying one is always explicit.
// Only the root bootstrap selects its declared initial release on the first visit.
const BASE_URL = new URL('./', import.meta.url);
const BASE_PATH = BASE_URL.pathname;
const MANIFEST_URL = new URL('release.json', BASE_URL).href;
const PIN_KEY = `lessonloop.activeRelease:${BASE_PATH}`;
const VERSION_PATTERN = /^[a-zA-Z0-9._-]+$/;
const currentVersion = document.documentElement.dataset.release || 'legacy';
const initialVersion = document.documentElement.dataset.initialRelease;
const applyButton = document.getElementById('apply-update');
const status = document.getElementById('update-status');
const summary = document.getElementById('update-summary');
let applying = false;

function showStatus(message, state = '') {
  if (status) {
    status.textContent = message;
    status.dataset.state = state;
  }
}

function validVersion(version) {
  return typeof version === 'string' && VERSION_PATTERN.test(version) &&
    version !== '.' && version !== '..';
}

function releasePath(version) {
  if (!validVersion(version)) throw new Error('버전 정보가 올바르지 않습니다.');
  return `${BASE_PATH}releases/${version}/index.html`;
}

function validatePin(value) {
  if (typeof value !== 'string') return null;
  const prefix = `${BASE_PATH}releases/`;
  if (!value.startsWith(prefix)) return null;
  const match = /^([a-zA-Z0-9._-]+)\/index\.html$/.exec(value.slice(prefix.length));
  if (!match || !validVersion(match[1])) return null;
  return value === releasePath(match[1]) ? value : null;
}

function validateRelease(value) {
  if (!value || !validVersion(value.version) || typeof value.url !== 'string' ||
      !value.url || /[\\?#\u0000-\u0020]/.test(value.url)) {
    throw new Error('업데이트 정보가 올바르지 않습니다.');
  }
  let url;
  try { url = new URL(value.url, BASE_URL); }
  catch { throw new Error('업데이트 주소가 올바르지 않습니다.'); }
  const expected = releasePath(value.version);
  const relative = `releases/${value.version}/index.html`;
  const canonical = value.url === relative || value.url === `./${relative}` ||
    value.url === expected || value.url === `${BASE_URL.origin}${expected}`;
  // Do not accept a spelling that URL normalization silently moves back into
  // this project (raw or percent-encoded traversal, duplicate slashes, etc.).
  if (!canonical) throw new Error('업데이트 주소가 올바르지 않습니다.');
  if (url.origin !== BASE_URL.origin || url.origin !== location.origin ||
      url.username || url.password || url.search || url.hash ||
      url.pathname !== expected || !validatePin(url.pathname)) {
    throw new Error('업데이트 주소가 올바르지 않습니다.');
  }
  return {
    version: value.version,
    path: expected,
    summary: typeof value.summary === 'string' ? value.summary : '',
  };
}

async function fetchRelease() {
  const response = await fetch(MANIFEST_URL, {
    cache: 'no-store',
    credentials: 'same-origin',
    redirect: 'error',
  });
  if (!response.ok) throw new Error('업데이트 정보를 확인하지 못했습니다. 다시 눌러 주세요.');
  return validateRelease(await response.json());
}

function isCurrent(release) {
  return currentVersion === release.version || location.pathname === release.path;
}

function showRelease(release) {
  if (summary) summary.textContent = release.summary;
  if (isCurrent(release)) showStatus('최신 버전입니다.', 'current');
  else showStatus(`새 버전 ${release.version}이 준비되어 있습니다.`, 'available');
}

async function applyUpdate() {
  if (applying) return;
  applying = true;
  if (applyButton) applyButton.disabled = true;
  try {
    showStatus('업데이트를 확인하고 있습니다.');
    const release = await fetchRelease();
    showRelease(release);
    if (isCurrent(release)) return;

    // This transport hook may fade/stop playback. Discovery must never call it.
    if (typeof window.lessonLoopPrepareUpdate === 'function') {
      const prepared = await window.lessonLoopPrepareUpdate();
      if (prepared === false) {
        showStatus('업데이트 적용을 취소했습니다.');
        return;
      }
    }
    try { localStorage.setItem(PIN_KEY, release.path); }
    catch { throw new Error('업데이트 설정을 저장하지 못했습니다. 브라우저의 저장소 설정을 확인한 뒤 다시 눌러 주세요.'); }
    showStatus('선택한 새 버전을 열고 있습니다.');
    location.assign(release.path);
  } catch (error) {
    showStatus(error?.message || '업데이트를 적용하지 못했습니다. 다시 눌러 주세요.', 'error');
  } finally {
    applying = false;
    if (applyButton) applyButton.disabled = false;
  }
}

function openRootSelection() {
  const isRoot = location.pathname === BASE_PATH ||
    location.pathname === `${BASE_PATH}index.html`;
  if (!isRoot) return false;

  let pin;
  try { pin = validatePin(localStorage.getItem(PIN_KEY)); }
  catch {
    showStatus('저장된 버전을 읽지 못했습니다. 브라우저의 저장소 설정을 확인한 뒤 업데이트 적용을 눌러 주세요.', 'error');
    if (applyButton) applyButton.disabled = false;
    return true;
  }
  if (pin) {
    showStatus('선택한 버전을 열고 있습니다.');
    location.replace(pin);
    return true;
  }

  // The bootstrap's initial version is fixed by its build, not by the manifest.
  if (!validVersion(initialVersion)) {
    showStatus('기본 버전 정보를 확인하지 못했습니다. 업데이트 적용을 눌러 다시 시도해 주세요.', 'error');
    if (applyButton) applyButton.disabled = false;
    return true;
  }
  const path = releasePath(initialVersion);
  try { localStorage.setItem(PIN_KEY, path); }
  catch {
    // Do not navigate without retaining the chosen version: that would lose the
    // manual-update preference or repeatedly select a new default on reopening.
    showStatus('기본 버전을 저장하지 못했습니다. 브라우저의 저장소 설정을 확인한 뒤 업데이트 적용을 눌러 주세요.', 'error');
    if (applyButton) applyButton.disabled = false;
    return true;
  }
  showStatus(`기본 버전 ${initialVersion}을 열고 있습니다.`);
  location.replace(path);
  return true;
}

function initialize() {
  if (applyButton) {
    applyButton.disabled = true;
    applyButton.addEventListener('click', applyUpdate);
  }
  if (openRootSelection()) return;

  showStatus('업데이트를 확인하고 있습니다.');
  fetchRelease().then(showRelease).catch(error => {
    showStatus(error?.message || '업데이트 정보를 확인하지 못했습니다. 다시 눌러 주세요.', 'error');
  }).finally(() => {
    if (applyButton) applyButton.disabled = false;
  });
}

initialize();
