// =============================================================================
// Tabs Module
// =============================================================================

/**
 * Initializes tab switching behavior.
 * Tabs and panels are linked by ID convention: tab-{name} -> panel-{name}
 */
export function initTabs() {
  const tabs = document.querySelectorAll('.tab[role="tab"]');
  const panels = document.querySelectorAll('.tab-panel');

  tabs.forEach((tab) => {
    tab.addEventListener('click', function () {
      const tabId = this.id;

      tabs.forEach((t) => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });

      this.classList.add('active');
      this.setAttribute('aria-selected', 'true');

      panels.forEach((p) => p.classList.remove('active'));

      if (tabId === 'tab-overview') {
        document.getElementById('panel-overview').classList.add('active');
      } else if (tabId === 'tab-rebalancing') {
        document.getElementById('panel-rebalancing').classList.add('active');
      }
    });
  });
}
