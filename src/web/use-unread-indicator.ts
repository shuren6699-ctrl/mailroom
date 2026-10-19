import { useEffect } from "react";

/** Keep the browser tab's count global, even while viewing one inbox or settings. */
export function useUnreadIndicator(unreadCount: number | undefined) {
  useEffect(() => {
    if (unreadCount === undefined) return;

    const originalTitle = document.title;
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    const originalHref = icon?.getAttribute("href");
    let cancelled = false;

    document.title = unreadCount > 0 ? `(${unreadCount}) Mailroom` : "Mailroom";

    if (icon && originalHref && unreadCount > 0) {
      const image = new Image();
      image.onload = () => {
        // A read action or navigation may have changed the count while loading.
        if (cancelled) return;
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 32;
        const context = canvas.getContext("2d");
        if (!context) return;

        context.drawImage(image, 0, 0, 32, 32);
        const label = unreadCount > 99 ? "99+" : String(unreadCount);
        context.font = "bold 18px Arial, sans-serif";
        const width = Math.min(32, Math.ceil(context.measureText(label).width) + 4);
        // A white backing keeps the small numerals legible on any tab color.
        context.fillStyle = "#ffffff";
        context.fillRect(32 - width, 14, width, 18);
        context.fillStyle = "#171717";
        context.textAlign = "center";
        context.textBaseline = "alphabetic";
        context.fillText(label, 32 - width / 2, 30, width - 2);
        icon.href = canvas.toDataURL("image/png");
      };
      image.src = originalHref;
    }

    return () => {
      cancelled = true;
      document.title = originalTitle;
      if (icon && originalHref) icon.setAttribute("href", originalHref);
    };
  }, [unreadCount]);
}
