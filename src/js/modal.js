// =============================================================================
// Modal Module
// =============================================================================

/**
 * Animates a modal window from a trigger element's position.
 * @param {HTMLElement} sourceElement - The button that triggered the modal
 * @param {HTMLElement} modalWindow - The modal window element
 * @param {HTMLElement} modalOverlay - The modal overlay element
 */
function animateModalFromElement(sourceElement, modalWindow, modalOverlay) {
  const rect = sourceElement.getBoundingClientRect();
  const buttonX = rect.left + rect.width / 2;
  const buttonY = rect.top + rect.height / 2;
  const modalWidth = modalWindow.offsetWidth;
  const modalHeight = modalWindow.offsetHeight;
  const modalX = window.innerWidth / 2 - modalWidth / 2;
  const modalY = window.innerHeight / 2 - modalHeight / 2;
  const originX = buttonX - modalX;
  const originY = buttonY - modalY;
  modalWindow.style.transformOrigin = `${originX}px ${originY}px`;
  modalOverlay.classList.add('active');
}

/**
 * Sets up modal open/close behavior.
 * @param {string} triggerId - ID of the trigger button
 * @param {string} modalOverlayId - ID of the modal overlay
 * @param {string} modalWindowId - ID of the modal window
 * @param {string} closeId - ID of the close button
 */
export function setupModal(triggerId, modalOverlayId, modalWindowId, closeId) {
  const trigger = document.getElementById(triggerId);
  const overlay = document.getElementById(modalOverlayId);
  const windowEl = document.getElementById(modalWindowId);
  const closeBtn = document.getElementById(closeId);

  trigger.addEventListener('click', function () {
    animateModalFromElement(this, windowEl, overlay);
  });

  closeBtn.addEventListener('click', () => overlay.classList.remove('active'));

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.classList.remove('active');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('active')) {
      overlay.classList.remove('active');
    }
  });
}
