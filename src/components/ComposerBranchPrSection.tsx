/**
 * Branch menu's **Pull request** section — one compact row per PR.
 *
 * The branch-bound PR comes first, then every other PR this chat watches on
 * another branch, so one menu lists and stops every mount the chat holds. Each
 * row carries its own watch control (a trailing bell) instead of a full-width
 * button under the PR: the section stays short with several mounts, and a
 * control always sits on the PR it belongs to.
 */

import { IconBell, IconBellOff } from "@/components/icons";
import { Tip } from "@/components/ui/tooltip";
import {
  PR_MENU_TITLE_MAX,
  formatPrChipLabel,
  prWatchKey,
} from "@/lib/prMonitor";

/** Height the PR row list may grow to before it scrolls. */
export const PR_LIST_MAX_H = 160;

/** Localized copy the section reads (a slice of the branch menu's catalog). */
export type ComposerPrSectionLabels = {
  pr?: string;
  prEmpty?: string;
  prWatch?: string;
  prUnwatch?: string;
  prWatchTip?: string;
  prUnwatchTip?: string;
  prOpenHub?: string;
  /** Follow-ups waiting for an idle session. */
  prPendingWakes?: string;
  /** Short "watching" tag in the section head. */
  prWatchingLabel?: string;
  /** `Last update: {summary}` prefix for the change line. */
  prLastUpdate?: string;
  /** Shown when the host reported a poll failure for this watch. */
  prUnavailable?: string;
};

/** Minimal PR shape the branch chip needs to render. */
export type PrChipEntry = {
  number: number;
  title: string;
  state?: string | null;
  /** Localized checks rollup ("" when unknown). */
  checksLine?: string | null;
};

/** One mounted PR the section lists next to the bound one. */
export type PrWatchEntry = {
  /** Mount identity (`projectPath` + `branch`), for stopping that watch. */
  projectPath: string;
  branch: string;
  number: number;
  title: string;
  state?: string | null;
  /** Localized checks rollup ("" when unknown). */
  checksLine?: string | null;
  /** A stop-watching call is in flight for this mount. */
  busy?: boolean;
};

type Props = {
  /** PR bound to the branch on screen, or `null`. */
  pr?: PrChipEntry | null;
  /** A host watch is mounted for the branch on screen. */
  prWatching?: boolean;
  /** A watch/unwatch call for the bound PR is in flight. */
  prBusy?: boolean;
  /** Localized one-line summaries of the changes that woke the session. */
  prUpdates?: string[] | null;
  /** Wakes waiting for the session to go idle. */
  prPendingWakes?: number;
  /** Last host poll failure for the bound watch. */
  prWatchError?: string | null;
  /** Other PRs this chat watches on other branches. */
  prOtherWatches?: PrWatchEntry[] | null;
  disabled?: boolean;
  labels: ComposerPrSectionLabels;
  /** Row click: the parent closes the menu and opens the PR hub. */
  onOpenPrHub?: (prNumber: number) => void;
  onTogglePrWatch?: () => void;
  onUnwatchPr?: (watch: PrWatchEntry) => void;
};

/**
 * What the section will show, so the menu can reserve its height up front:
 * `visible` false renders nothing, `rows` is one 36px row per PR.
 */
export function composerPrSection(input: {
  pr?: PrChipEntry | null;
  prWatching?: boolean;
  prOtherWatches?: PrWatchEntry[] | null;
  /** Other mounts are only listed when they can also be stopped. */
  canStopOther?: boolean;
}): { visible: boolean; rows: number } {
  const others = input.canStopOther ? (input.prOtherWatches ?? []) : [];
  return {
    visible: !!input.pr || !!input.prWatching || others.length > 0,
    rows: (input.pr ? 1 : 0) + others.length,
  };
}

export function ComposerBranchPrSection({
  pr = null,
  prWatching = false,
  prBusy = false,
  prUpdates = null,
  prPendingWakes = 0,
  prWatchError = null,
  prOtherWatches = null,
  disabled,
  labels,
  onOpenPrHub,
  onTogglePrWatch,
  onUnwatchPr,
}: Props) {
  const otherPrRows = onUnwatchPr ? (prOtherWatches ?? []) : [];
  const prMeta = pr
    ? [String(pr.state ?? "").trim(), String(pr.checksLine ?? "").trim()]
        .filter(Boolean)
        .join(" · ")
    : "";
  const pendingLabel =
    prPendingWakes > 0 && labels.prPendingWakes
      ? labels.prPendingWakes.replace("{count}", String(prPendingWakes))
      : "";
  // Watched PRs in this section, bound row included: the head tag says the chat
  // is following something, each row's bell says whether that PR is followed.
  const watchedCount = (prWatching && pr ? 1 : 0) + otherPrRows.length;

  return (
    <div className="cwm__pr">
      <div className="cwm__head cwm__pr-head">
        <span>{labels.pr || "Pull request"}</span>
        {watchedCount > 0 && labels.prWatchingLabel ? (
          <span className="cwm__pr-tag">{labels.prWatchingLabel}</span>
        ) : null}
      </div>
      {pr || otherPrRows.length > 0 ? (
        <ul
          className="cwm__list cwm__list--pr"
          style={{ maxHeight: PR_LIST_MAX_H }}
        >
          {pr ? (
            <li className="cwm__row">
              <div className="cwm__row-inner">
                <button
                  type="button"
                  role="menuitem"
                  className="cmm__opt cwm__item cwm__pr-row"
                  title={
                    labels.prOpenHub
                      ? `${pr.title}\n${labels.prOpenHub}`
                      : pr.title
                  }
                  onClick={() => onOpenPrHub?.(pr.number)}
                >
                  <span className="cwm__item-main">
                    <span className="cwm__item-name">
                      {formatPrChipLabel(pr, PR_MENU_TITLE_MAX)}
                    </span>
                    {prMeta ? (
                      <span className="cwm__item-meta">{prMeta}</span>
                    ) : null}
                  </span>
                </button>
                {onTogglePrWatch ? (
                  <Tip
                    label={prWatching ? labels.prUnwatchTip : labels.prWatchTip}
                    /* The tip says what watching does, so it must not be cut:
                       several locales need a second line for that. */
                    className="ui-tip--wrap"
                  >
                    <button
                      type="button"
                      className={
                        "cwm__row-toggle" + (prWatching ? " is-on" : "")
                      }
                      aria-pressed={prWatching}
                      aria-label={
                        prWatching
                          ? labels.prUnwatch || "Stop watching"
                          : labels.prWatch || "Watch this PR"
                      }
                      disabled={disabled || prBusy}
                      onClick={() => onTogglePrWatch()}
                    >
                      {prWatching ? (
                        <IconBellOff size={14} aria-hidden />
                      ) : (
                        <IconBell size={14} aria-hidden />
                      )}
                    </button>
                  </Tip>
                ) : null}
              </div>
            </li>
          ) : null}
          {otherPrRows.map((w) => {
            const key = prWatchKey(w.projectPath, w.branch);
            const meta = [
              String(w.state ?? "").trim(),
              String(w.checksLine ?? "").trim(),
              w.branch,
            ]
              .filter(Boolean)
              .join(" · ");
            const title = [w.title, w.branch, labels.prOpenHub]
              .filter(Boolean)
              .join("\n");
            return (
              <li className="cwm__row" key={key}>
                <div className="cwm__row-inner">
                  <button
                    type="button"
                    role="menuitem"
                    className="cmm__opt cwm__item cwm__pr-row"
                    title={title}
                    onClick={() => onOpenPrHub?.(w.number)}
                  >
                    <span className="cwm__item-main">
                      <span className="cwm__item-name">
                        {formatPrChipLabel(w, PR_MENU_TITLE_MAX)}
                      </span>
                      {meta ? (
                        <span className="cwm__item-meta">{meta}</span>
                      ) : null}
                    </span>
                  </button>
                  <Tip label={labels.prUnwatchTip}>
                    <button
                      type="button"
                      className="cwm__row-toggle is-on"
                      aria-pressed
                      aria-label={labels.prUnwatch || "Stop watching"}
                      disabled={disabled || !!w.busy}
                      onClick={() => onUnwatchPr?.(w)}
                    >
                      <IconBellOff size={14} aria-hidden />
                    </button>
                  </Tip>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="cwm__empty">
          {labels.prEmpty || "No pull request for this branch"}
        </p>
      )}
      {prWatching && prUpdates && prUpdates.length > 0 ? (
        <p className="cwm__empty cwm__empty--hint">
          {labels.prLastUpdate
            ? labels.prLastUpdate.replace("{summary}", prUpdates[0])
            : prUpdates[0]}
        </p>
      ) : null}
      {prWatching && prWatchError && labels.prUnavailable ? (
        <p className="cwm__empty cwm__empty--hint">{labels.prUnavailable}</p>
      ) : null}
      {pendingLabel ? (
        <p className="cwm__empty cwm__empty--hint">{pendingLabel}</p>
      ) : null}
    </div>
  );
}
