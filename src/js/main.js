// =============================================================================
// Main Entry Point
// =============================================================================

import '../styles/main.scss';
import { setupModal } from './modal.js';
import { initSidebarNav } from './sidebar-nav.js';
import { initTabs } from './tabs.js';
import { initDragDrop } from './drag-drop.js';
import { initPortfolioApp } from './portfolio-app.js';

// Initialize modals
setupModal('btn-archive', 'archive-modal-overlay', 'archive-modal-window', 'archive-modal-close');
setupModal('btn-settings', 'settings-modal-overlay', 'settings-modal-window', 'settings-modal-close');

// Initialize sidebar navigation (for both Archive and Settings modals)
initSidebarNav();

// Initialize tab switching
initTabs();

// Initialize drag & drop
initDragDrop();

// Validazione dell'allocazione ed eliminazione degli asset sono gestiti da
// portfolio-app.js (validateCurrentAllocation, bindSettings).
initPortfolioApp();
