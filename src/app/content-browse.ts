import type { ContentKind } from "./types";

/** A request from an instance tab or a crash fix to open the main content browser for that target. */
export interface ContentBrowseRequest {
  kind: ContentKind;
  instanceId?: string;
  query?: string;
}

/**
 * Content discovery and installation belongs to the main download view, including its DOM-only compatibility rail. A
 * custom event lets the instance tabs ask the app to open that view without importing the whole shell or falling back to
 * the legacy browse modal.
 */
export function browseContent(request: ContentBrowseRequest) {
  window.dispatchEvent(new CustomEvent<ContentBrowseRequest>("vitrine:browse", { detail: request }));
}
