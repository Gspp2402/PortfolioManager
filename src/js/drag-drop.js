let draggedRow = null;

function sectionName(row) {
  let current = row;
  while (current && !current.classList.contains('section-row')) {
    current = current.previousElementSibling;
  }
  return current?.querySelector('.section-label')?.textContent.trim().toUpperCase() ?? '';
}

function clearIndicators() {
  document.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach((row) => {
    row.classList.remove('drag-over-top', 'drag-over-bottom');
  });
}

function finishDrop() {
  if (!draggedRow) return;
  const row = draggedRow;
  row.classList.remove('dragging');
  row.setAttribute('draggable', 'false');
  const tableBody = row.closest('tbody');
  clearIndicators();
  draggedRow = null;
  tableBody?.dispatchEvent(new CustomEvent('portfolio:reorder', { bubbles: true }));
}

export function initDragDrop() {
  document.addEventListener('mousedown', (event) => {
    const handle = event.target.closest('.drag-handle');
    const row = handle?.closest('.asset-row');
    if (row) row.setAttribute('draggable', 'true');
  });

  document.addEventListener('dragstart', (event) => {
    const row = event.target.closest('.asset-row');
    if (!row || row.getAttribute('draggable') !== 'true') {
      event.preventDefault();
      return;
    }
    draggedRow = row;
    row.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', row.dataset.importId || 'asset');
  });

  document.addEventListener('dragend', () => {
    if (!draggedRow) return;
    draggedRow.classList.remove('dragging');
    draggedRow.setAttribute('draggable', 'false');
    draggedRow = null;
    clearIndicators();
  });

  document.addEventListener('dragover', (event) => {
    if (!draggedRow) return;
    const target = event.target.closest('.asset-row, .empty-asset-row, .section-row');
    if (!target || target === draggedRow || target.closest('tbody') !== draggedRow.closest('tbody')) return;
    if (draggedRow.closest('#allocazione-tbody') &&
        (sectionName(draggedRow) === 'CASH' || sectionName(target) === 'CASH')) return;
    event.preventDefault();
    clearIndicators();
    const rect = target.getBoundingClientRect();
    target.classList.add(event.clientY < rect.top + rect.height / 2 ? 'drag-over-top' : 'drag-over-bottom');
  });

  document.addEventListener('drop', (event) => {
    if (!draggedRow) return;
    const target = event.target.closest('.asset-row, .empty-asset-row, .section-row');
    if (!target || target === draggedRow || target.closest('tbody') !== draggedRow.closest('tbody')) return;
    if (draggedRow.closest('#allocazione-tbody') &&
        (sectionName(draggedRow) === 'CASH' || sectionName(target) === 'CASH')) {
      finishDrop();
      return;
    }
    event.preventDefault();
    if (target.classList.contains('section-row')) {
      const firstRow = target.nextElementSibling;
      target.parentNode.insertBefore(draggedRow, firstRow);
    } else if (target.classList.contains('empty-asset-row')) {
      target.parentNode.insertBefore(draggedRow, target);
    } else {
      const rect = target.getBoundingClientRect();
      const before = event.clientY < rect.top + rect.height / 2;
      if (before) target.parentNode.insertBefore(draggedRow, target);
      else target.parentNode.insertBefore(draggedRow, target.nextElementSibling);
    }
    finishDrop();
  });
}
