import { useState, useEffect } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/useToast';
import { apiGet, apiPost, apiPut, apiDelete, type NewBook, type NewBookChapter, type NewBooksResponse, type PoolItemsResponse } from '../lib/api';
import { BookOpen, Plus, Edit2, Trash2, X, ArrowUpDown, Download, FileText, Clock, Tag } from 'lucide-react';

export default function Composer() {
  const [books, setBooks] = useState<NewBook[]>([]);
  const [poolItems, setPoolItems] = useState<any[]>([]);
  const [selectedBook, setSelectedBook] = useState<NewBook | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showAddChapterModal, setShowAddChapterModal] = useState(false);
  const [newBookTitle, setNewBookTitle] = useState('');
  const [editingBook, setEditingBook] = useState<NewBook | null>(null);
  const [loading, setLoading] = useState(false);
  const toast = useToast();

  useEffect(() => {
    fetchBooks();
    fetchPoolItems();
  }, []);

  async function fetchBooks() {
    setLoading(true);
    try {
      const res = await apiGet<NewBooksResponse>('/books/new');
      setBooks(res.books || []);
    } catch (err) {
      toast.error(String(err));
    } finally {
      setLoading(false);
    }
  }

  async function fetchPoolItems() {
    try {
      const res = await apiGet<PoolItemsResponse>('/pool');
      setPoolItems(res.items || []);
    } catch (err) {
      toast.error(String(err));
    }
  }

  async function handleCreate() {
    if (!newBookTitle.trim()) {
      toast.error('请输入书名');
      return;
    }
    try {
      await apiPost<NewBook>('/books/new', { title: newBookTitle });
      toast.success('创建成功');
      setShowCreateModal(false);
      setNewBookTitle('');
      fetchBooks();
    } catch (err) {
      toast.error(String(err));
    }
  }

  async function handleEdit(book: NewBook) {
    setEditingBook(book);
    setShowEditModal(true);
  }

  async function handleSaveEdit() {
    if (!editingBook) return;
    try {
      await apiPut<NewBook>(`/books/new/${editingBook.id}`, editingBook);
      toast.success('保存成功');
      setShowEditModal(false);
      fetchBooks();
    } catch (err) {
      toast.error(String(err));
    }
  }

  async function handleDelete(bookId: string) {
    if (!confirm('确定删除该书？')) return;
    try {
      await apiDelete(`/books/new/${bookId}`);
      toast.success('删除成功');
      if (selectedBook?.id === bookId) setSelectedBook(null);
      fetchBooks();
    } catch (err) {
      toast.error(String(err));
    }
  }

  async function handleAddChapter(poolItemId: string) {
    if (!selectedBook) return;
    try {
      await apiPost<NewBookChapter>(`/books/new/${selectedBook.id}/chapters`, { poolItemId });
      toast.success('章节添加成功');
      setShowAddChapterModal(false);
      fetchBooks();
      const updated = books.find(b => b.id === selectedBook.id);
      if (updated) setSelectedBook(updated);
    } catch (err) {
      toast.error(String(err));
    }
  }

  async function handleRemoveChapter(chapterId: string) {
    if (!selectedBook) return;
    try {
      await apiDelete(`/books/new/${selectedBook.id}/chapters/${chapterId}`);
      toast.success('章节已移除');
      fetchBooks();
      const updated = books.find(b => b.id === selectedBook.id);
      if (updated) setSelectedBook(updated);
    } catch (err) {
      toast.error(String(err));
    }
  }

  async function handleExport(bookId: string) {
    try {
      await apiPost(`/books/new/${bookId}/export`);
      toast.success('导出成功');
    } catch (err) {
      toast.error(String(err));
    }
  }

  const availablePoolItems = poolItems.filter(item => {
    if (!selectedBook) return false;
    return !selectedBook.chapters.some(ch => ch.sourcePoolItemId === item.id);
  });

  const stats = {
    totalBooks: books.length,
    totalChapters: books.reduce((sum, book) => sum + book.chapters.length, 0),
    avgChapters: books.length ? Math.round(books.reduce((sum, book) => sum + book.chapters.length, 0) / books.length) : 0,
    finishedBooks: books.filter(b => b.totalChapters > 0).length,
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <span className="block text-[11px] font-bold uppercase tracking-[1.6px] text-muted">Book Composer</span>
          <h1 className="mt-0.5 text-[18px] font-bold">新书组合</h1>
        </div>
        <Button onClick={() => setShowCreateModal(true)}>
          <Plus className="mr-2 h-4 w-4" />
          创建新书
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="p-3 border-glow">
          <div className="flex items-center gap-2 mb-1">
            <BookOpen className="h-4 w-4 text-accent-2" />
            <span className="text-xs text-muted">总新书</span>
          </div>
          <div className="text-2xl font-bold text-gradient">{stats.totalBooks}</div>
        </Card>
        <Card className="p-3">
          <div className="flex items-center gap-2 mb-1">
            <FileText className="h-4 w-4 text-cyan" />
            <span className="text-xs text-muted">总章节</span>
          </div>
          <div className="text-2xl font-bold text-cyan">{stats.totalChapters}</div>
        </Card>
        <Card className="p-3">
          <div className="flex items-center gap-2 mb-1">
            <ArrowUpDown className="h-4 w-4 text-warn" />
            <span className="text-xs text-muted">平均章节</span>
          </div>
          <div className="text-2xl font-bold text-warn">{stats.avgChapters}</div>
        </Card>
        <Card className="p-3">
          <div className="flex items-center gap-2 mb-1">
            <Clock className="h-4 w-4 text-ok" />
            <span className="text-xs text-muted">已完成</span>
          </div>
          <div className="text-2xl font-bold text-ok">{stats.finishedBooks}</div>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <Card className="lg:col-span-1 overflow-hidden">
          <div className="p-4 border-b border-white/[0.06]">
            <h2 className="text-sm font-semibold">新书列表</h2>
          </div>
          <div className="max-h-[600px] overflow-y-auto">
            {loading ? (
              <div className="p-4 text-center text-muted">加载中…</div>
            ) : books.length === 0 ? (
              <div className="p-4 text-center text-muted">暂无新书</div>
            ) : (
              books.map((book) => (
                <div
                  key={book.id}
                  onClick={() => setSelectedBook(book)}
                  className={`border-b border-white/[0.05] px-4 py-3 transition-colors cursor-pointer ${
                    selectedBook?.id === book.id ? 'bg-surface-3' : 'hover:bg-surface-3/60'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium text-txt">{book.title}</div>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-xs text-muted">{book.chapters.length} 章节</span>
                        <Badge className={book.totalChapters > 0 ? 'bg-ok/15 text-ok' : 'bg-warn/15 text-warn'}>
                          {book.totalChapters > 0 ? '已完成' : '创作中'}
                        </Badge>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={(e) => { e.stopPropagation(); handleEdit(book); }}
                        className="rounded p-1 text-muted transition-colors hover:text-txt"
                        title="编辑"
                      >
                        <Edit2 className="h-4 w-4" />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDelete(book.id); }}
                        className="rounded p-1 text-muted transition-colors hover:text-rose-400"
                        title="删除"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>

        <Card className="lg:col-span-2 overflow-hidden">
          {selectedBook ? (
            <>
              <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
                <div>
                  <h2 className="text-sm font-semibold">{selectedBook.title}</h2>
                  <span className="text-xs text-muted">ID: {selectedBook.id}</span>
                </div>
                <Button onClick={() => handleExport(selectedBook.id)} size="sm">
                  <Download className="mr-2 h-4 w-4" />
                  导出
                </Button>
              </div>

              <div className="p-4">
                <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{selectedBook.chapters.length} 章节</Badge>
                    <Badge className={selectedBook.totalChapters > 0 ? 'bg-ok/15 text-ok' : 'bg-warn/15 text-warn'}>
                      {selectedBook.totalChapters > 0 ? '已完成' : '创作中'}
                    </Badge>
                  </div>
                  <Button size="sm" onClick={() => setShowAddChapterModal(true)}>
                    <Plus className="mr-2 h-4 w-4" />
                    添加章节
                  </Button>
                </div>

                {selectedBook.chapters.length === 0 ? (
                  <div className="text-center py-8 text-muted">
                    <BookOpen className="h-12 w-12 mx-auto mb-3 opacity-50" />
                    <p>暂无章节，点击上方按钮从大纲池添加</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {selectedBook.chapters.map((chapter, index) => (
                      <div
                        key={chapter.id}
                        className="flex items-center gap-3 p-3 rounded-lg border border-white/[0.06] bg-surface-3/40"
                      >
                        <span className="w-8 h-8 flex items-center justify-center rounded-md bg-accent/15 text-accent-2 text-sm font-bold">
                          {index + 1}
                        </span>
                        <div className="flex-1">
                          <div className="text-sm font-medium text-txt">{chapter.title}</div>
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-xs text-muted">来源: {chapter.sourcePoolItemId}</span>
                          </div>
                        </div>
                        <button
                          onClick={() => handleRemoveChapter(chapter.id)}
                          className="rounded p-1 text-muted transition-colors hover:text-rose-400"
                          title="移除章节"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center justify-center py-16 text-muted">
              <BookOpen className="h-16 w-16 mb-4 opacity-30" />
              <p className="text-lg">选择一本新书查看详情</p>
              <p className="text-sm mt-1">或创建一本新书开始组合章节</p>
            </div>
          )}
        </Card>
      </div>

      {showCreateModal && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-5 backdrop-blur-md"
          onClick={() => setShowCreateModal(false)}
        >
          <div
            className="flex w-[min(500px,94vw)] flex-col rounded-2xl border border-white/[0.1] bg-surface-2 shadow-[0_24px_60px_-28px_rgba(0,0,0,0.8)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 border-b border-white/[0.06] px-4.5 py-3.5">
              <Plus className="h-5 w-5" />
              <strong className="text-[15px]">创建新书</strong>
              <button
                className="ml-auto text-muted transition-colors hover:text-txt"
                onClick={() => setShowCreateModal(false)}
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-5">
              <label className="block text-xs text-muted mb-1">书名</label>
              <Input
                value={newBookTitle}
                onChange={(e) => setNewBookTitle(e.target.value)}
                placeholder="输入新书名称..."
              />
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-white/[0.06] px-4.5 py-3.5">
              <Button variant="outline" onClick={() => setShowCreateModal(false)}>
                取消
              </Button>
              <Button onClick={handleCreate}>创建</Button>
            </div>
          </div>
        </div>
      )}

      {showEditModal && editingBook && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-5 backdrop-blur-md"
          onClick={() => setShowEditModal(false)}
        >
          <div
            className="flex w-[min(500px,94vw)] flex-col rounded-2xl border border-white/[0.1] bg-surface-2 shadow-[0_24px_60px_-28px_rgba(0,0,0,0.8)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 border-b border-white/[0.06] px-4.5 py-3.5">
              <Edit2 className="h-5 w-5" />
              <strong className="text-[15px]">编辑新书</strong>
              <button
                className="ml-auto text-muted transition-colors hover:text-txt"
                onClick={() => setShowEditModal(false)}
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="block text-xs text-muted mb-1">书名</label>
                <Input
                  value={editingBook.title}
                  onChange={(e) => setEditingBook({ ...editingBook, title: e.target.value })}
                />
              </div>
              <div>
                <label className="block text-xs text-muted mb-1">作者</label>
                <Input
                  value={editingBook.author}
                  onChange={(e) => setEditingBook({ ...editingBook, author: e.target.value })}
                />
              </div>
              <div>
                <label className="block text-xs text-muted mb-1">题材</label>
                <Input
                  value={editingBook.genre}
                  onChange={(e) => setEditingBook({ ...editingBook, genre: e.target.value })}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-white/[0.06] px-4.5 py-3.5">
              <Button variant="outline" onClick={() => setShowEditModal(false)}>
                取消
              </Button>
              <Button onClick={handleSaveEdit}>保存</Button>
            </div>
          </div>
        </div>
      )}

      {showAddChapterModal && selectedBook && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-5 backdrop-blur-md"
          onClick={() => setShowAddChapterModal(false)}
        >
          <div
            className="flex w-[min(600px,94vw)] flex-col rounded-2xl border border-white/[0.1] bg-surface-2 shadow-[0_24px_60px_-28px_rgba(0,0,0,0.8)] max-h-[80vh]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 border-b border-white/[0.06] px-4.5 py-3.5">
              <Plus className="h-5 w-5" />
              <strong className="text-[15px]">从大纲池添加章节</strong>
              <button
                className="ml-auto text-muted transition-colors hover:text-txt"
                onClick={() => setShowAddChapterModal(false)}
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-4 overflow-y-auto">
              {availablePoolItems.length === 0 ? (
                <div className="text-center py-8 text-muted">
                  <Tag className="h-12 w-12 mx-auto mb-3 opacity-50" />
                  <p>大纲池已无可用章节</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {availablePoolItems.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center justify-between p-3 rounded-lg border border-white/[0.06] bg-surface-3/40 hover:border-accent/30 transition-colors"
                    >
                      <div>
                        <div className="text-sm font-medium text-txt">{item.outlineName}</div>
                        <div className="flex items-center gap-2 mt-1">
                          <Badge variant="outline" className="text-[11px]">{item.genre}</Badge>
                          <span className="text-xs text-muted">{item.wordCount} 字</span>
                        </div>
                      </div>
                      <Button size="sm" onClick={() => handleAddChapter(item.id)}>
                        添加
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-white/[0.06] px-4.5 py-3.5">
              <Button variant="outline" onClick={() => setShowAddChapterModal(false)}>
                关闭
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}