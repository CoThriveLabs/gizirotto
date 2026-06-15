/**
 * エディタ共通定数・ユーティリティ（Phase 4 リファクタ）。
 *
 * ZoomPanel / UndoRedoButtons / UndoArrow が使うズーム定数・clampZoom を
 * bbox-coords.ts から re-export する。
 * 呼出側は "@/components/editor/constants" を import するだけでよい。
 */
export {
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_STEP,
  clampZoom,
} from '@/lib/pdf-output/bbox-coords'
