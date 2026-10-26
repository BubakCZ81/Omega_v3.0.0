declare const __OMEGA_DEPENDENCY_VERSIONS__: {
  pinets: string;
  vela: string;
  velaPinets: string;
};

interface GitHubTag {
  name: string;
}

interface UpdateTarget {
  label: string;
  repository: string;
  currentVersion: string;
}

type UpdateResult =
  | { target: UpdateTarget; latestVersion: string }
  | { target: UpdateTarget; error: string };

function isGitHubTag(value: unknown): value is GitHubTag {
  return typeof value === 'object'
    && value !== null
    && 'name' in value
    && typeof value.name === 'string';
}

export function parseStableVersion(tag: string): number[] | null {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag.trim());
  return match ? match.slice(1).map(Number) : null;
}

export function compareVersions(left: string, right: string): number {
  const leftParts = parseStableVersion(left);
  const rightParts = parseStableVersion(right);
  if (!leftParts || !rightParts) throw new Error('Only stable three-part semantic versions can be compared.');
  for (let index = 0; index < leftParts.length; index++) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

export async function fetchLatestStableVersion(
  repository: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchImplementation(`https://api.github.com/repos/${repository}/tags?per_page=100`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}.`);

  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) throw new Error('GitHub returned an invalid tags response.');
  const versions = payload.flatMap((tag: unknown) => {
    if (!isGitHubTag(tag) || !parseStableVersion(tag.name)) return [];
    return [tag.name.replace(/^v/, '')];
  });
  if (!versions.length) throw new Error('No stable semantic-version tags were found.');
  return versions.reduce((latest, version) => compareVersions(latest, version) < 0 ? version : latest);
}

function updateTargets(): UpdateTarget[] {
  return [
    { label: 'PineTS', repository: 'LuxAlgo/PineTS', currentVersion: __OMEGA_DEPENDENCY_VERSIONS__.pinets },
    { label: 'Vela', repository: 'LuxAlgo/Vela', currentVersion: __OMEGA_DEPENDENCY_VERSIONS__.vela },
    { label: 'Vela PineTS adapter', repository: 'LuxAlgo/Vela-pinets', currentVersion: __OMEGA_DEPENDENCY_VERSIONS__.velaPinets },
  ];
}

async function checkTarget(target: UpdateTarget): Promise<UpdateResult> {
  try {
    return { target, latestVersion: await fetchLatestStableVersion(target.repository) };
  } catch (error) {
    return { target, error: error instanceof Error ? error.message : String(error) };
  }
}

interface UpdateDialogElements {
  modal: HTMLElement | null;
  message: HTMLElement | null;
  close: HTMLElement | null;
}

function updateDialogElements(): UpdateDialogElements {
  return {
    modal: document.getElementById('update-info-modal'),
    message: document.getElementById('update-info-message'),
    close: document.getElementById('update-info-close'),
  };
}

let updateCheckRunning = false;

/** Opens the update dialog and checks the three dependency repositories. */
export async function checkForUpdates(): Promise<void> {
  if (updateCheckRunning) return;
  const { modal, message, close } = updateDialogElements();
  if (!modal || !message || !close) throw new Error('The update-checker controls are missing from the page.');

  updateCheckRunning = true;
  modal.hidden = false;
  modal.setAttribute('aria-hidden', 'false');
  message.textContent = 'Checking GitHub tags…';
  delete message.dataset.state;
  try {
    const results = await Promise.all(updateTargets().map(checkTarget));
    const updates = results.filter((result): result is Extract<UpdateResult, { latestVersion: string }> =>
      'latestVersion' in result && compareVersions(result.target.currentVersion, result.latestVersion) < 0);
    const failures = results.filter((result): result is Extract<UpdateResult, { error: string }> => 'error' in result);
    const summary = updates.length
      ? `Updates available: ${updates.map(({ target, latestVersion }) =>
        `${target.label} ${target.currentVersion} → ${latestVersion}`).join('; ')}.`
      : failures.length
        ? 'No update result is available for every component.'
        : 'All checked components are up to date.';
    const failureSummary = failures.length
      ? ` Could not check ${failures.map(({ target, error }) => `${target.label}: ${error}`).join('; ')}.`
      : '';
    const nextStep = updates.length ? ' Update dependencies deliberately and rebuild Omega to apply them.' : '';
    message.textContent = `${summary}${failureSummary}${nextStep}`;
    message.dataset.state = updates.length ? 'available' : failures.length ? 'error' : 'current';
  } finally {
    updateCheckRunning = false;
  }
}

export function initializeUpdateChecker(): void {
  const { modal, close } = updateDialogElements();
  if (!modal || !close) throw new Error('The update-checker controls are missing from the page.');

  const closeModal = () => {
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
  };
  close.addEventListener('click', closeModal);
  modal.addEventListener('click', event => {
    if (event.target === modal) closeModal();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !modal.hidden) closeModal();
  });
}
