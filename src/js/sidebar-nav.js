// =============================================================================
// Sidebar Navigation Module
// =============================================================================

/**
 * Initializes sidebar navigation for all sidebar layouts on the page.
 * Handles switching between panes within a modal.
 */
export function initSidebarNav() {
  document.querySelectorAll('.sidebar-layout').forEach((layout) => {
    const navItems = layout.querySelectorAll('.sidebar-nav-item');
    const panes = layout.querySelectorAll('.sidebar-pane');

    navItems.forEach((item) => {
      item.addEventListener('click', function () {
        navItems.forEach((nav) => nav.classList.remove('active'));
        panes.forEach((pane) => pane.classList.remove('active'));
        this.classList.add('active');
        const target = layout.querySelector('#' + this.dataset.target);
        if (target) {
          target.classList.add('active');
        }
      });
    });
  });
}
