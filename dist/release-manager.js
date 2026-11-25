// A newly published release is never applied until the user clicks the button.
const RELEASE_PATH = /^\/releases\/[a-zA-Z0-9._-]+\/index\.html$/;
const PIN_KEY = 'lessonloop.activeRelease';
const currentVersion = document.documentElement.dataset.release || 'legacy';
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

function validateRelease(value) {
  if (!value || typeof value.version !== 'string' ||
      !/^[a-zA-Z0-9._-]+$/.test(value.version) || typeof value.url !== 'string') {
    throw new Error('업데이트 정보가 올바르지 않습니다.');
  }
  const url = new URL(value.url, `${location.origin}/`);
  if (url.origin !== location.origin || url.search || url.hash ||
      !RELEASE_PATH.test(url.pathname)) {
    throw new Error('업데이트 주소가 올바르지 않습니다.');
  }
  return {
    version: value.version,
    path: url.pathname,
    summary: typeof value.summary === 'string' ? value.summary : '',
  };
}

async function fetchRelease() {
  const response = await fetch('/release.json', {
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

    // This optional transport hook is called only from the explicit button click.
    if (typeof window.lessonLoopPrepareUpdate === 'function') {
      const prepared = await window.lessonLoopPrepareUpdate();
      if (prepared === false) {
        showStatus('업데이트 적용을 취소했습니다.');
        return;
      }
    }
    try {
      localStorage.setItem(PIN_KEY, release.path);
    } catch {
      throw new Error('업데이트 설정을 저장하지 못했습니다. 브라우저의 저장소 설정을 확인해 주세요.');
    }
    showStatus('선택한 새 버전을 열고 있습니다.');
    location.assign(release.path);
  } catch (error) {
    showStatus(error.message || '업데이트를 적용하지 못했습니다. 다시 눌러 주세요.', 'error');
  } finally {
    applying = false;
    if (applyButton) applyButton.disabled = false;
  }
}

function initialize() {
  // Opening the root may reuse a version that this user explicitly chose before.
  // Merely discovering a newer manifest must never set this pin or navigate.
  if (location.pathname === '/' || location.pathname === '/index.html') {
    let pinned = null;
    try { pinned = localStorage.getItem(PIN_KEY); } catch { /* A read failure does not update anything. */ }
    if (typeof pinned === 'string' && RELEASE_PATH.test(pinned)) {
      location.replace(pinned);
      return;
    }
  }

  if (applyButton) {
    applyButton.disabled = true;
    applyButton.addEventListener('click', applyUpdate);
  }
  showStatus('업데이트를 확인하고 있습니다.');
  fetchRelease().then(showRelease).catch(error => {
    showStatus(error.message || '업데이트 정보를 확인하지 못했습니다. 다시 눌러 주세요.', 'error');
  }).finally(() => {
    if (applyButton) applyButton.disabled = false;
  });
}

initialize();
