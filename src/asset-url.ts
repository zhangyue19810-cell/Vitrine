/** Public resources resolve against the page, so the same build works from a folder, a custom protocol or a sub-path. */
export const assetUrl = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\//, "")}`;
