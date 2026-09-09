/**
 * Provider-hosted player (VIDEO_PIPELINE §9: embeds only, no custom player).
 * `src` comes from `getEmbedSource`, which already encodes the start second in
 * the provider's supported mechanism.
 */
export function VideoEmbed({ src, title }: { src: string; title: string }) {
  return (
    <div className="overflow-hidden rounded-[20px] bg-neutral-900 shadow-sm">
      <iframe
        src={src}
        title={title}
        className="aspect-video w-full"
        allow="autoplay; fullscreen; picture-in-picture"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
      />
    </div>
  );
}
