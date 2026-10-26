import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import { Table, TableRow, TableHeader, TableCell } from "@tiptap/extension-table";
import { TaskList, TaskItem } from "@tiptap/extension-list";

// Define extensions compatible with standard Markdown features
// We use the default Tiptap extensions to handle basic content
// Node names must match what Docmost stores: table, tableRow, tableHeader,
// tableCell, taskList, taskItem (verified against existing page JSON).
export const tiptapExtensions = [
  StarterKit.configure({
    // Explicitly enable features that might be disabled in some contexts
    codeBlock: {},
    heading: {},
  }),
  Image.configure({
    inline: true,
  }),
  Link.configure({
    openOnClick: false,
  }),
  Table,
  TableRow,
  TableHeader,
  TableCell,
  TaskList,
  TaskItem.configure({
    nested: true,
  }),
];
