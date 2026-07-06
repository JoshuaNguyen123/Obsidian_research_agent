export type DesignPackageKind =
  | "ui_flow"
  | "logistics_system"
  | "service_blueprint"
  | "project_ideation"
  | "architecture"
  | "mind_map";

export type DesignItemKind =
  | "persona"
  | "screen"
  | "actor"
  | "service"
  | "resource"
  | "queue"
  | "database"
  | "milestone"
  | "risk"
  | "metric"
  | "dependency"
  | "decision"
  | "note";

export interface DesignPackageItem {
  id: string;
  kind: DesignItemKind;
  title: string;
  summary: string;
  details?: string[];
  metadata?: Record<string, string | number | boolean>;
}

export interface DesignPackageEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
}

export interface CreateDesignPackageInput {
  title: string;
  kind: DesignPackageKind;
  targetFolder?: string;
  items: DesignPackageItem[];
  edges: DesignPackageEdge[];
  briefMarkdown?: string;
  overwrite?: false;
}

export interface CreateDesignPackageResult {
  canvasPath: string;
  briefPath: string;
  itemCount: number;
  edgeCount: number;
  bytesWritten: number;
}
