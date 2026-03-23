import { useStore } from '../../stores';
import { AttachmentChip } from '../shared/AttachmentChip';

export function QuotedSelectionCard() {
  const quotedSelection = useStore(s => s.quotedSelection);
  const clearQuotedSelection = useStore(s => s.clearQuotedSelection);

  if (!quotedSelection) return null;

  return (
    <AttachmentChip
      icon={<GridIcon />}
      name={quotedSelection.text}
      onRemove={clearQuotedSelection}
    />
  );
}

function GridIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="6" y1="4" x2="6" y2="20" />
      <line x1="18" y1="4" x2="18" y2="20" />
      <line x1="6" y1="8" x2="18" y2="8" />
      <line x1="6" y1="16" x2="18" y2="16" />
    </svg>
  );
}
