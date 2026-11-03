/**
 * Types shared with the core. They are imported as types only, so nothing from the Node side ends up in the
 * browser bundle and the two halves cannot drift apart.
 */
export type { Settings, AfterLaunch } from "../../core/src/settings";
export type { CoreEvent, GameSnapshot } from "../../core/src/events";
export type { TaskSnapshot, TaskState, TaskKind, TaskStage, UiLevel } from "../../core/src/tasks";
export type { Progress, LaneState, LaneStateName } from "../../core/src/net/download";
export type { InstanceInfo, InstanceConfig, ReleaseKind } from "../../core/src/mc/instances";
export type { InstanceSummary } from "../../core/src/core";
export type { PublicAccount, LoginChallenge, AccountType } from "../../core/src/account/types";
export type { CrashAnalysis, CrashFinding, CrashFix } from "../../core/src/crash/analyzer";
export type { GameLine, GameLifecycle } from "../../core/src/mc/launcher";
export type { JavaInstall } from "../../core/src/java/detect";
export type { LoaderVersion } from "../../core/src/loaders/meta";
export type { ContentProject, ContentVersion, ContentSearchResult, ContentKind, ContentSource, ModUpdate, InstallContentResult } from "../../core/src/content/browse";
export type { LocalMod, ModProblem } from "../../core/src/content/local-mods";
export type { ResourcePackInfo, ShaderPackInfo, ScreenshotInfo } from "../../core/src/content/packs-local";
export type { SaveInfo } from "../../core/src/world/saves";
export type { ServerEntry } from "../../core/src/world/servers";
export type { ServerStatus } from "../../core/src/net/mc-ping";
export type { PackPreview, PackInstallResult, PackState } from "../../core/src/pack/install";
export type { ExportCandidate } from "../../core/src/pack/export";
export type { LatestPack } from "../../core/src/pack/online";
export type { JvmPresetInfo, MemoryAdvice } from "../../core/src/mc/jvm";
export type { SourcePolicy } from "../../core/src/net/sources";
