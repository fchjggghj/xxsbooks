import * as React from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/useToast';
import { apiGet, apiPost, apiPut, apiDelete, type LibraryBook } from '@/lib/api';
import { X, RefreshCw, Upload, Tag, Edit2, Trash2, BookOpen } from 'lucide-react';

const STATUS_LABEL: Record<string, string> = {
  raw: '原始',
  broken: '已拆大纲',
  adapted: '已改编',
  pooled: '已入池',
};

const STATUS_COLOR: Record<string, 'default' | 'success' | 'warning' | 'destructive'> = {
  raw: 'default',
  broken: 'success',
  adapted: 'warning',
  pooled: 'destructive',
};

export default function Library() {
  const [books, setBooks] = React.useState<LibraryBook[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [filter, setFilter] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState<string>('');
  const [selectedBook, setSelectedBook] = React.useState<LibraryBook | null>(null);
  const [editingBook, setEditingBook] = React.useState<LibraryBook | null>(null);
  const [editForm, setEditForm] = React.useState({ name: '', author: '', tags: '' });
  const toast = useToast();

  const loadBooks = async () => {
    setLoading(true);
    try {
      let url = '/library';
      if (filter) url += `?q=${encodeURIComponent(filter)}`;
      else if (statusFilter) url += `?status=${statusFilter}`;
      const data = await apiGet<{ books: LibraryBook[] }>(url);
      setBooks(data.books);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  };

  React.useEffect(() => {
    loadBooks();
  }, [filter, statusFilter]);

  const handleSync = async () => {
    try {
      await apiPost('/library/sync');
      toast.success('同步完成');
      loadBooks();
    } catch (e) {
      toast.error(String(e));
    }
  };

  const handleMigrate = async () => {
    try {
      await apiPost('/library/migrate');
      toast.success('迁移完成');
      loadBooks();
    } catch (e) {
      toast.error(String(e));
    }
  };

  const handleDelete = async (bookId: string) => {
    if (!confirm('确定要删除这本书吗？')) return;
    try {
      await apiDelete(`/library/book?id=${bookId}`);
      toast.success('删除成功');
      loadBooks();
    } catch (e) {
      toast.error(String(e));
    }
  };

  const handleEdit = (book: LibraryBook) => {
    setEditingBook(book);
    setEditForm({
      name: book.name,
      author: book.author,
      tags: book.tags.join(', '),
    });
  };

  const handleSaveEdit = async () => {
    if (!editingBook) return;
    try {
      await apiPut('/library/book', {
        id: editingBook.id,
        updates: {
          name: editForm.name,
          author: editForm.author,
          tags: editForm.tags.split(',').map((t) => t.trim()).filter(Boolean),
        },
      });
      toast.success('保存成功');
      setEditingBook(null);
      loadBooks();
    } catch (e) {
      toast.error(String(e));
    }
  };

  const filteredBooks = books.filter((b) => {
    if (filter && !b.name.toLowerCase().includes(filter.toLowerCase())) return false;
    if (statusFilter && b.status !== statusFilter) return false;
    return true;
  });

  const stats = {
    total: books.length,
    raw: books.filter((b) => b.status === 'raw').length,
    broken: books.filter((b) => b.status === 'broken').length,
    adapted: books.filter((b) => b.status === 'adapted').length,
    pooled: books.filter((b) => b.status === 'pooled').length,
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={handleSync} disabled={loading}>
            <RefreshCw className="mr-2 h-4 w-4" />
            同步书库
          </Button>
          <Button variant="outline" onClick={handleMigrate}>
            <Upload className="mr-2 h-4 w-4" />
            迁移旧数据
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            placeholder="搜索书名…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-[200px]"
          />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="h-9 rounded-md border border-white/[0.1] bg-surface-2 px-3 text-sm text-txt"
          >
            <option value="">全部状态</option>
            <option value="raw">原始</option>
            <option value="broken">已拆大纲</option>
            <option value="adapted">已改编</option>
            <option value="pooled">已入池</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Card className="p-3">
          <div className="text-2xl font-bold">{stats.total}</div>
          <div className="text-xs text-muted">总书籍</div>
        </Card>
        <Card className="p-3">
          <div className="text-2xl font-bold">{stats.raw}</div>
          <div className="text-xs text-muted">原始</div>
        </Card>
        <Card className="p-3">
          <div className="text-2xl font-bold">{stats.broken}</div>
          <div className="text-xs text-muted">已拆大纲</div>
        </Card>
        <Card className="p-3">
          <div className="text-2xl font-bold">{stats.adapted}</div>
          <div className="text-xs text-muted">已改编</div>
        </Card>
        <Card className="p-3">
          <div className="text-2xl font-bold">{stats.pooled}</div>
          <div className="text-xs text-muted">已入池</div>
        </Card>
      </div>

      <Card>
        <div className="overflow-auto rounded-2xl">
          <table className="w-full min-w-[680px] border-collapse text-[13px]">
            <thead>
              <tr>
                <th className="sticky top-0 z-[2] border-b border-white/[0.06] bg-surface-2/95 px-3 py-2.5 text-left text-xs font-bold tracking-tight text-muted backdrop-blur-sm">
                  ID
                </th>
                <th className="sticky top-0 z-[2] border-b border-white/[0.06] bg-surface-2/95 px-3 py-2.5 text-left text-xs font-bold tracking-tight text-muted backdrop-blur-sm">
                  书名
                </th>
                <th className="sticky top-0 z-[2] border-b border-white/[0.06] bg-surface-2/95 px-3 py-2.5 text-left text-xs font-bold tracking-tight text-muted backdrop-blur-sm">
                  作者
                </th>
                <th className="sticky top-0 z-[2] border-b border-white/[0.06] bg-surface-2/95 px-3 py-2.5 text-left text-xs font-bold tracking-tight text-muted backdrop-blur-sm">
                  章节数
                </th>
                <th className="sticky top-0 z-[2] border-b border-white/[0.06] bg-surface-2/95 px-3 py-2.5 text-left text-xs font-bold tracking-tight text-muted backdrop-blur-sm">
                  字数
                </th>
                <th className="sticky top-0 z-[2] border-b border-white/[0.06] bg-surface-2/95 px-3 py-2.5 text-left text-xs font-bold tracking-tight text-muted backdrop-blur-sm">
                  状态
                </th>
                <th className="sticky top-0 z-[2] border-b border-white/[0.06] bg-surface-2/95 px-3 py-2.5 text-left text-xs font-bold tracking-tight text-muted backdrop-blur-sm">
                  标签
                </th>
                <th className="sticky top-0 z-[2] border-b border-white/[0.06] bg-surface-2/95 px-3 py-2.5 text-left text-xs font-bold tracking-tight text-muted backdrop-blur-sm">
                  操作
                </th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} className="py-5 text-center text-muted">
                    加载中…
                  </td>
                </tr>
              ) : filteredBooks.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-5 text-center text-muted">
                    无匹配书籍
                  </td>
                </tr>
              ) : (
                filteredBooks.map((book) => (
                  <tr
                    key={book.id}
                    onClick={() => setSelectedBook(book)}
                    className="cursor-pointer border-b border-white/[0.05] transition-colors hover:bg-surface-3/60"
                  >
                    <td className="px-3 py-2.5 font-mono text-xs text-muted">{book.id}</td>
                    <td className="px-3 py-2.5 max-w-[300px] truncate">
                      {book.name.slice(0, 40)}
                    </td>
                    <td className="px-3 py-2.5 text-muted">{book.author || '-'}</td>
                    <td className="px-3 py-2.5 tabular-nums">{book.totalChapters}</td>
                    <td className="px-3 py-2.5 text-muted tabular-nums">
                      {Math.round(book.wordCount / 10000)}万
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge variant={STATUS_COLOR[book.status]}>
                        {STATUS_LABEL[book.status]}
                      </Badge>
                    </td>
                    <td className="px-3 py-2.5">
                      {book.tags.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {book.tags.slice(0, 3).map((tag) => (
                            <Badge key={tag} variant="outline" className="text-[11px]">
                              <Tag className="mr-1 h-2 w-2" />
                              {tag}
                            </Badge>
                          ))}
                          {book.tags.length > 3 && (
                            <span className="text-xs text-muted">+{book.tags.length - 3}</span>
                          )}
                        </div>
                      ) : (
                        <span className="text-muted">-</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleEdit(book);
                          }}
                          className="rounded p-1 text-muted transition-colors hover:text-txt"
                          title="编辑"
                        >
                          <Edit2 className="h-4 w-4" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(book.id);
                          }}
                          className="rounded p-1 text-muted transition-colors hover:text-rose-400"
                          title="删除"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {selectedBook && (
        <BookDetailModal book={selectedBook} onClose={() => setSelectedBook(null)} />
      )}

      {editingBook && (
        <EditBookModal
          book={editingBook}
          form={editForm}
          onChange={setEditForm}
          onSave={handleSaveEdit}
          onClose={() => setEditingBook(null)}
        />
      )}
    </div>
  );
}

function BookDetailModal({
  book,
  onClose,
}: {
  book: LibraryBook;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-5 backdrop-blur-md"
      onClick={onClose}
    >
      <div
        className="flex w-[min(600px,94vw)] flex-col rounded-2xl border border-white/[0.1] bg-surface-2 shadow-[0_24px_60px_-28px_rgba(0,0,0,0.8)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-white/[0.06] px-4.5 py-3.5">
          <BookOpen className="h-5 w-5" />
          <strong className="text-[15px]">{book.name}</strong>
          <button
            className="ml-auto text-muted transition-colors hover:text-txt"
            onClick={onClose}
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-5 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-xs text-muted">ID</div>
              <div className="font-mono text-sm">{book.id}</div>
            </div>
            <div>
              <div className="text-xs text-muted">状态</div>
              <Badge variant={STATUS_COLOR[book.status]}>{STATUS_LABEL[book.status]}</Badge>
            </div>
            <div>
              <div className="text-xs text-muted">作者</div>
              <div>{book.author || '-'}</div>
            </div>
            <div>
              <div className="text-xs text-muted">来源</div>
              <div>{book.source}</div>
            </div>
            <div>
              <div className="text-xs text-muted">章节数</div>
              <div>{book.totalChapters}</div>
            </div>
            <div>
              <div className="text-xs text-muted">字数</div>
              <div>{(book.wordCount / 10000).toFixed(1)}万</div>
            </div>
          </div>
          {book.tags.length > 0 && (
            <div>
              <div className="text-xs text-muted">标签</div>
              <div className="flex flex-wrap gap-1 mt-1">
                {book.tags.map((tag) => (
                  <Badge key={tag} variant="outline" className="text-[11px]">
                    <Tag className="mr-1 h-2 w-2" />
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          <div className="flex gap-2 text-xs text-muted border-t border-white/[0.06] pt-3">
            <span>创建: {new Date(book.createdAt).toLocaleString('zh-CN')}</span>
            <span>更新: {new Date(book.updatedAt).toLocaleString('zh-CN')}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

interface EditBookForm {
  name: string;
  author: string;
  tags: string;
}

function EditBookModal({
  book,
  form,
  onChange,
  onSave,
  onClose,
}: {
  book: LibraryBook;
  form: EditBookForm;
  onChange: (form: EditBookForm) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-5 backdrop-blur-md"
      onClick={onClose}
    >
      <div
        className="flex w-[min(500px,94vw)] flex-col rounded-2xl border border-white/[0.1] bg-surface-2 shadow-[0_24px_60px_-28px_rgba(0,0,0,0.8)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-white/[0.06] px-4.5 py-3.5">
          <Edit2 className="h-5 w-5" />
          <strong className="text-[15px]">编辑书籍信息</strong>
          <button
            className="ml-auto text-muted transition-colors hover:text-txt"
            onClick={onClose}
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs text-muted mb-1">书名</label>
            <Input
              value={form.name}
              onChange={(e) => onChange({ ...form, name: e.target.value })}
            />
          </div>
          <div>
            <label className="block text-xs text-muted mb-1">作者</label>
            <Input
              value={form.author}
              onChange={(e) => onChange({ ...form, author: e.target.value })}
            />
          </div>
          <div>
            <label className="block text-xs text-muted mb-1">标签（逗号分隔）</label>
            <Input
              value={form.tags}
              onChange={(e) => onChange({ ...form, tags: e.target.value })}
              placeholder="快穿, 都市, 仙侠"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2 border-t border-white/[0.06]">
            <Button variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button onClick={onSave}>保存</Button>
          </div>
        </div>
      </div>
    </div>
  );
}