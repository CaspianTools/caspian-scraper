"use client";

import { useState } from "react";

/**
 * Photo gallery for a car listing: a large main image with a clickable
 * thumbnail strip. Clicking the main image opens the full-size photo in a
 * new tab. Plain <img> (external OpenSooq CDN) — Next/Image isn't used.
 */
export function CarGallery({
  images,
  title,
}: {
  images: string[];
  title: string;
}) {
  const [active, setActive] = useState(0);

  if (!images.length) {
    return (
      <div className="aspect-video w-full rounded-2xl bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-sm text-zinc-500">
        No photos
      </div>
    );
  }

  const idx = Math.min(active, images.length - 1);
  const main = images[idx];

  return (
    <div className="space-y-3">
      <a href={main} target="_blank" rel="noopener noreferrer" className="block">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={main}
          alt={title}
          className="w-full max-h-[70vh] object-contain rounded-2xl bg-zinc-100 dark:bg-zinc-900"
        />
      </a>
      {images.length > 1 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {images.map((img, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setActive(i)}
              aria-label={`Photo ${i + 1}`}
              className={
                "shrink-0 rounded-lg overflow-hidden border-2 transition-colors " +
                (i === idx
                  ? "border-black dark:border-white"
                  : "border-transparent hover:border-zinc-300 dark:hover:border-zinc-600")
              }
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={img}
                alt=""
                loading="lazy"
                className="w-24 h-16 object-cover bg-zinc-100 dark:bg-zinc-800"
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
