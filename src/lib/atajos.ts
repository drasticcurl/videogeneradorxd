/**
 * Filtro común para los atajos de teclado globales (los `keydown` en `window` de
 * Revisar, Imágenes y el Pipeline). Un solo lugar para que no diverjan.
 *
 * Tres casos que antes se colaban:
 *   - Con modificador: ⌘/Ctrl+A aprobaba, ⌘+Z deshacía y ⌘+S saltaba en vez de
 *     seleccionar todo, deshacer o guardar. Un atajo de la app nunca lleva modificador.
 *   - Con un diálogo abierto (un `Confirmar`, un menú): A/R/S seguían actuando por
 *     detrás del modal.
 *   - Las flechas, cuando el foco está en un control que las usa para sí mismo
 *     (select, radio, listbox, la manija del panel).
 */
export function ignorarAtajo(e: KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return true;
  if (
    document.querySelector(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
    )
  ) {
    return true;
  }
  if (e.key.startsWith("Arrow")) {
    const el = e.target as HTMLElement | null;
    if (
      el?.closest?.(
        'select, [role="combobox"], [role="listbox"], [role="radio"], [role="separator"]',
      )
    ) {
      return true;
    }
  }
  return false;
}
