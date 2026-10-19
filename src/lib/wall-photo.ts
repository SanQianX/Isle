import type { LayoutInput } from '@/features/gallery/best-photo-rows';

/**
 * The shape the photo wall renders.
 *
 * Declared here rather than inside the component so server pages and client
 * components can both import the type *and* the mapper without one having to
 * import from the other.
 */
export type WallPhoto = LayoutInput & {
  rank: number;
  title: string;
  description: string;
  uploader: string;
  score: number;
  upCount: number;
  downCount: number;
  currentVote: -1 | 0 | 1;
  preview1200Url: string;
  preview400Url: string;
};

/** Anything the mapper needs; keeps it independent of the query layer. */
export type WallPhotoSource = {
  id: string;
  rank: number;
  width: number;
  height: number;
  title: string;
  description: string;
  uploaderDisplayCode: string;
  score: number;
  upCount: number;
  downCount: number;
  currentVisitorVote: -1 | 0 | 1;
  preview400Url: string;
  preview1200Url: string;
};

export function toWallPhoto(photo: WallPhotoSource): WallPhoto {
  return {
    id: photo.id,
    rank: photo.rank,
    width: photo.width,
    height: photo.height,
    title: photo.title,
    description: photo.description,
    uploader: `访客 #${photo.uploaderDisplayCode}`,
    score: photo.score,
    upCount: photo.upCount,
    downCount: photo.downCount,
    currentVote: photo.currentVisitorVote,
    preview400Url: photo.preview400Url,
    preview1200Url: photo.preview1200Url,
  };
}
