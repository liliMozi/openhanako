import { WidgetType, Decoration } from '@codemirror/view';

export class HrWidget extends WidgetType {
  toDOM() {
    // eslint-disable-next-line no-restricted-syntax -- CodeMirror WidgetType.toDOM(), not React-managed DOM
    const el = document.createElement('span');
    el.className = 'cm-hr-widget';
    return el;
  }
  eq() { return true; }
}

export const hrDecoration = Decoration.replace({ widget: new HrWidget() });
