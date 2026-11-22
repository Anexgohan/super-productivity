/**
 * Sidebar folders (anex/app-actions), built as MenuTreeService builds a drag in the sidebar or a folder's rename and delete.
 *
 * The app's reducer takes any tree it is given, so a builder checks what the sidebar guarantees: each id once, and every item a real
 * project or tag.
 */
import {
  deleteFolder,
  updateFolder,
  updateProjectTree,
  updateTagTree,
} from '../../../../src/app/features/menu-tree/store/menu-tree.actions';
import { selectMenuTreeState } from '../../../../src/app/features/menu-tree/store/menu-tree.selectors';
import {
  MenuTreeKind,
  type MenuTreeState,
  type MenuTreeTreeNode,
} from '../../../../src/app/features/menu-tree/store/menu-tree.model';
import { selectProjectFeatureState } from '../../../../src/app/features/project/store/project.selectors';
import type { ProjectState } from '../../../../src/app/features/project/project.model';
import { selectTagFeatureState } from '../../../../src/app/features/tag/store/tag.reducer';
import type { TagState } from '../../../../src/app/features/tag/tag.model';
import type { MenuTreeInputNode } from '../../src/action-inputs';
import {
  ActionInputError,
  built,
  type BuildContext,
  type Builder,
} from './build-context';

type MenuTreeAction =
  | 'updateProjectTree'
  | 'updateTagTree'
  | 'updateFolder'
  | 'deleteFolder';

/** The input tree as the app's nodes, checked: every id once, every item an existing project or tag. */
const appTree = (
  ctx: BuildContext,
  tree: MenuTreeInputNode[],
  itemKind: MenuTreeKind.PROJECT | MenuTreeKind.TAG,
): MenuTreeTreeNode[] => {
  const entities =
    itemKind === MenuTreeKind.PROJECT
      ? (ctx.select(selectProjectFeatureState as never) as ProjectState).entities
      : (ctx.select(selectTagFeatureState as never) as TagState).entities;
  const seen = new Set<string>();
  const convert = (node: MenuTreeInputNode): MenuTreeTreeNode => {
    if (seen.has(node.id)) {
      throw new ActionInputError(`The tree lists ${node.id} more than once.`, 400);
    }
    seen.add(node.id);
    if (node.k !== 'f') {
      if (!entities[node.id]) {
        throw new ActionInputError(`Not found in the tree: ${node.id}`, 404);
      }
      return { k: itemKind, id: node.id } as MenuTreeTreeNode;
    }
    return {
      k: MenuTreeKind.FOLDER,
      id: node.id,
      name: node.name,
      ...(node.isExpanded === undefined ? {} : { isExpanded: node.isExpanded }),
      children: node.children.map(convert),
    };
  };
  return tree.map(convert);
};

/** The folder, checked to be in the named tree; returns the app's kind for that tree. */
const folderTree = (
  ctx: BuildContext,
  tree: 'project' | 'tag',
  folderId: string,
): MenuTreeKind.PROJECT | MenuTreeKind.TAG => {
  const state = ctx.select(selectMenuTreeState as never) as MenuTreeState;
  const has = (nodes: MenuTreeTreeNode[]): boolean =>
    nodes.some(
      (n) => n.k === MenuTreeKind.FOLDER && (n.id === folderId || has(n.children)),
    );
  if (!has(tree === 'project' ? state.projectTree : state.tagTree)) {
    throw new ActionInputError(`Folder not found: ${folderId}`, 404);
  }
  return tree === 'project' ? MenuTreeKind.PROJECT : MenuTreeKind.TAG;
};

export const MENU_TREE_BUILDERS: { [N in MenuTreeAction]: Builder<N> } = {
  updateProjectTree: (ctx, { tree }) =>
    built(updateProjectTree({ tree: appTree(ctx, tree, MenuTreeKind.PROJECT) })),

  updateTagTree: (ctx, { tree }) =>
    built(updateTagTree({ tree: appTree(ctx, tree, MenuTreeKind.TAG) })),

  updateFolder: (ctx, { tree, folderId, name }) =>
    built(updateFolder({ folderId, name, treeType: folderTree(ctx, tree, folderId) })),

  deleteFolder: (ctx, { tree, folderId }) =>
    built(deleteFolder({ folderId, treeType: folderTree(ctx, tree, folderId) })),
};
