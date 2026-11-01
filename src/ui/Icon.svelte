<script lang="ts" module>
  /** 24×24 stroke icons, drawn for Dline. */
  const PATHS = {
    mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z M5 11a7 7 0 0 0 14 0 M12 18v3',
    'mic-off': 'M15 9.3V6a3 3 0 0 0-5.7-1.3 M9 9v3a3 3 0 0 0 5 2.2 M5 11a7 7 0 0 0 11.4 5.4 M19 11a7 7 0 0 1-.6 2.8 M12 18v3 M3 3l18 18',
    camera: 'M3 7h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z M17 10.5l5-3v9l-5-3',
    'camera-off': 'M10.6 7H15a2 2 0 0 1 2 2v4.4 M17 10.5l5-3v9l-5-3 M13.6 17H3a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h.6 M2 2l20 20',
    flip: 'M4 12a8 8 0 0 1 13.7-5.7L20 8.5 M20 4v4.5h-4.5 M20 12a8 8 0 0 1-13.7 5.7L4 15.5 M4 20v-4.5h4.5',
    phone: 'M5 4h3.5l1.8 4.5-2.3 1.4a11 11 0 0 0 6.1 6.1l1.4-2.3L20 15.5V19a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1Z',
    'phone-off': 'M3.2 15.6 5.6 18a1 1 0 0 0 1.3.1l2.6-1.9a1 1 0 0 0 .3-1.2l-.7-1.6a11.6 11.6 0 0 1 5.8 0l-.7 1.6a1 1 0 0 0 .3 1.2l2.6 1.9a1 1 0 0 0 1.3-.1l2.4-2.4a1 1 0 0 0 0-1.4A15.5 15.5 0 0 0 12 9.5a15.5 15.5 0 0 0-8.8 4.7 1 1 0 0 0 0 1.4Z',
    send: 'M12 19V5 M6 11l6-6 6 6',
    share: 'M12 15V3 M7 8l5-5 5 5 M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6',
    copy: 'M9 9h10v12H9z M5 15H4V3h12v1',
    check: 'M5 12.5l4.5 4.5L19 7',
    close: 'M6 6l12 12 M18 6L6 18',
    settings: 'M4 7h10 M18 7h2 M16 5v4 M4 17h4 M12 17h8 M10 15v4',
    download: 'M12 4v12 M7 11l5 5 5-5 M5 20h14',
    alert: 'M12 8v5 M12 16.5v.5 M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
    shield: 'M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6l-7-3Z M9 12l2 2 4-4',
    info: 'M12 11v6 M12 7.5V8 M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
    file: 'M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8l-5-5Z M14 3v5h5',
    chevron: 'M9 6l6 6-6 6',
  } as const;
  export type IconName = keyof typeof PATHS;
</script>

<script lang="ts">
  /** Decorative only: the control or text next to it carries the meaning. */
  let { name, size = 22 }: { name: IconName; size?: number } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.8"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <path d={PATHS[name]} />
</svg>
