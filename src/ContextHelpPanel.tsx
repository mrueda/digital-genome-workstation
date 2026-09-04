import type { ContextHelpTopic } from "./ContextHelp";

export function ContextHelpPanel({
  topic,
  expanded,
  pinned,
  onExpandedChange,
  onPinnedChange
}: {
  topic: ContextHelpTopic;
  expanded: boolean;
  pinned: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onPinnedChange: (pinned: boolean) => void;
}) {
  if (!expanded) {
    return <button type="button" className="context-help-collapsed" data-context-help-ignore onClick={() => onExpandedChange(true)}>
      <span>ⓘ</span><b>Context Help</b><small>{topic.title}</small><i>⌃</i>
    </button>;
  }

  return <section className="context-help-panel" aria-label="Context Help" data-context-help-ignore>
    <header>
      <span><i>ⓘ</i><b>Context Help</b><small>{pinned ? "pinned" : "follows pointer and focus"}</small></span>
      <span>
        <button type="button" className={pinned ? "is-active" : ""} aria-pressed={pinned} onClick={() => onPinnedChange(!pinned)}>{pinned ? "Unpin" : "Pin"}</button>
        <button type="button" title="Collapse Context Help" aria-label="Collapse Context Help" onClick={() => onExpandedChange(false)}>⌄</button>
      </span>
    </header>
    <div className="context-help-copy">
      <h3>{topic.title}</h3>
      <p><b>Purpose</b>{topic.purpose}</p>
      <p><b>Effect</b>{topic.effect}</p>
      {topic.limitation && <p className="context-help-limitation"><b>Note</b>{topic.limitation}</p>}
    </div>
  </section>;
}
