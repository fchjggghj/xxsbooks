import { useState, useEffect } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/useToast';
import { apiGet, apiPost, apiPut, apiDelete, type AdaptDirection, type DirectionsResponse, type BatchSyncResponse, type LibraryBook } from '../lib/api';
import { Search, RefreshCw, Edit2, Trash2, X, ChevronRight, Sparkles } from 'lucide-react';

export default function Direction() {
  const [directions, setDirections] = useState<AdaptDirection[]>([]);
  const [books, setBooks] = useState<LibraryBook[]>([]);
  const [selectedBookId, setSelectedBookId] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [filterWorldIndex, setFilterWorldIndex] = useState('');
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingDirection, setEditingDirection] = useState<AdaptDirection | null>(null);
  const [loading, setLoading] = useState(false);
  const toast = useToast();

  useEffect(() => {
    fetchDirections();
    fetchBooks();
  }, []);

  async function fetchDirections() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (selectedBookId) params.set('bookId', selectedBookId);
      const res = await apiGet<DirectionsResponse>(`/directions?${params.toString()}`);
      setDirections(res.directions);
    } catch (err) {
      toast.error(String(err));
    } finally {
      setLoading(false);
    }
  }

  async function fetchBooks() {
    try {
      const res = await apiGet<{ books: LibraryBook[] }>('/library');
      setBooks(res.books);
    } catch (err) {
      toast.error(String(err));
    }
  }

  async function handleBatchSync() {
    try {
      await apiPost<BatchSyncResponse>('/directions/batch');
      toast.success('批量同步完成');
      fetchDirections();
    } catch (err) {
      toast.error(String(err));
    }
  }

  async function handleEdit(direction: AdaptDirection) {
    setEditingDirection(direction);
    setShowEditModal(true);
  }

  async function handleSave() {
    if (!editingDirection) return;
    try {
      await apiPut<AdaptDirection>(`/directions/${editingDirection.id}`, editingDirection);
      toast.success('保存成功');
      setShowEditModal(false);
      fetchDirections();
    } catch (err) {
      toast.error(String(err));
    }
  }

  async function handleDelete(directionId: string) {
    if (!confirm('确定删除该改编方向？')) return;
    try {
      await apiDelete(`/directions/${directionId}`);
      toast.success('删除成功');
      fetchDirections();
    } catch (err) {
      toast.error(String(err));
    }
  }

  const filteredDirections = directions.filter((d) => {
    const matchQuery = !searchQuery ||
      d.worldName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      d.coreConflict.toLowerCase().includes(searchQuery.toLowerCase());
    const matchBook = !selectedBookId || d.bookId === selectedBookId;
    const matchIndex = !filterWorldIndex || String(d.worldIndex) === filterWorldIndex;
    return matchQuery && matchBook && matchIndex;
  });

  const worldIndices = [...new Set(directions.map((d) => d.worldIndex))];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <span className="block text-[11px] font-bold uppercase tracking-[1.6px] text-muted">Adaptation Direction</span>
          <h1 className="mt-0.5 text-[18px] font-bold">改编方向管理</h1>
        </div>
        <Button onClick={handleBatchSync} disabled={loading}>
          <RefreshCw className="mr-2 h-4 w-4" />
          批量同步
        </Button>
      </div>

      <Card className="p-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs text-muted mb-1.5">选择书籍</label>
            <select
              value={selectedBookId}
              onChange={(e) => setSelectedBookId(e.target.value)}
              className="w-full h-9 rounded-md border border-white/[0.1] bg-surface-2 px-3 text-sm text-txt focus:outline-none focus:ring-2 focus:ring-accent/40"
            >
              <option value="">全部书籍</option>
              {books.map((book) => (
                <option key={book.id} value={book.id}>
                  {book.name} ({book.id})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-muted mb-1.5">世界编号</label>
            <select
              value={filterWorldIndex}
              onChange={(e) => setFilterWorldIndex(e.target.value)}
              className="w-full h-9 rounded-md border border-white/[0.1] bg-surface-2 px-3 text-sm text-txt focus:outline-none focus:ring-2 focus:ring-accent/40"
            >
              <option value="">全部编号</option>
              {worldIndices.map((idx) => (
                <option key={idx} value={String(idx)}>世界 {idx}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-muted mb-1.5">搜索</label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索世界名称或核心冲突..."
                className="pl-9"
              />
            </div>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="p-3 border-glow">
          <div className="flex items-center gap-2 mb-1">
            <Sparkles className="h-4 w-4 text-accent-2" />
            <span className="text-xs text-muted">总改编方向</span>
          </div>
          <div className="text-2xl font-bold text-gradient">{directions.length}</div>
        </Card>
        <Card className="p-3">
          <div className="flex items-center gap-2 mb-1">
            <ChevronRight className="h-4 w-4 text-cyan" />
            <span className="text-xs text-muted">关联书籍</span>
          </div>
          <div className="text-2xl font-bold text-cyan">{worldIndices.length}</div>
        </Card>
        <Card className="p-3">
          <div className="flex items-center gap-2 mb-1">
            <Search className="h-4 w-4 text-ok" />
            <span className="text-xs text-muted">当前筛选</span>
          </div>
          <div className="text-2xl font-bold text-ok">{filteredDirections.length}</div>
        </Card>
        <Card className="p-3">
          <div className="flex items-center gap-2 mb-1">
            <Badge variant="outline" className="h-4 w-4 p-0">📝</Badge>
            <span className="text-xs text-muted">平均字数</span>
          </div>
          <div className="text-2xl font-bold text-violet">
            {directions.length ? Math.round(directions.reduce((sum, d) => sum + d.coreConflict.length, 0) / directions.length) : 0}
          </div>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <div className="overflow-auto rounded-2xl">
          <table className="w-full min-w-[720px] border-collapse text-[13px]">
            <thead>
              <tr>
                <th className="sticky top-0 z-[2] border-b border-white/[0.06] bg-surface-2/95 px-3 py-2.5 text-left text-xs font-bold tracking-tight text-muted backdrop-blur-sm">
                  书籍
                </th>
                <th className="sticky top-0 z-[2] border-b border-white/[0.06] bg-surface-2/95 px-3 py-2.5 text-left text-xs font-bold tracking-tight text-muted backdrop-blur-sm">
                  世界
                </th>
                <th className="sticky top-0 z-[2] border-b border-white/[0.06] bg-surface-2/95 px-3 py-2.5 text-left text-xs font-bold tracking-tight text-muted backdrop-blur-sm">
                  核心冲突
                </th>
                <th className="sticky top-0 z-[2] border-b border-white/[0.06] bg-surface-2/95 px-3 py-2.5 text-left text-xs font-bold tracking-tight text-muted backdrop-blur-sm">
                  主角
                </th>
                <th className="sticky top-0 z-[2] border-b border-white/[0.06] bg-surface-2/95 px-3 py-2.5 text-left text-xs font-bold tracking-tight text-muted backdrop-blur-sm">
                  风格
                </th>
                <th className="sticky top-0 z-[2] border-b border-white/[0.06] bg-surface-2/95 px-3 py-2.5 text-left text-xs font-bold tracking-tight text-muted backdrop-blur-sm">
                  主题
                </th>
                <th className="sticky top-0 z-[2] border-b border-white/[0.06] bg-surface-2/95 px-3 py-2.5 text-left text-xs font-bold tracking-tight text-muted backdrop-blur-sm">
                  创建时间
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
              ) : filteredDirections.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-5 text-center text-muted">
                    暂无改编方向数据
                  </td>
                </tr>
              ) : (
                filteredDirections.map((direction) => (
                  <tr
                    key={direction.id}
                    className="border-b border-white/[0.05] transition-colors hover:bg-surface-3/60"
                  >
                    <td className="px-3 py-2.5">
                      <Badge variant="outline" className="font-mono">
                        {direction.bookId}
                      </Badge>
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge className="bg-accent/15 text-accent-2">
                        世界{direction.worldIndex}: {direction.worldName}
                      </Badge>
                    </td>
                    <td className="px-3 py-2.5 max-w-xs">
                      <p className="text-sm text-txt truncate" title={direction.coreConflict}>
                        {direction.coreConflict}
                      </p>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="text-sm text-txt">{direction.protagonist.name}</div>
                      <div className="text-xs text-muted">{direction.protagonist.personality}</div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="text-sm text-txt">{direction.tone}</div>
                      <div className="text-xs text-muted">{direction.readerTarget}</div>
                    </td>
                    <td className="px-3 py-2.5 text-sm text-muted">
                      {direction.theme}
                    </td>
                    <td className="px-3 py-2.5 text-sm text-muted">
                      {new Date(direction.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => handleEdit(direction)}
                          className="rounded p-1 text-muted transition-colors hover:text-txt"
                          title="编辑"
                        >
                          <Edit2 className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(direction.id)}
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

      {showEditModal && editingDirection && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-5 backdrop-blur-md"
          onClick={() => setShowEditModal(false)}
        >
          <div
            className="flex w-[min(700px,94vw)] flex-col rounded-2xl border border-white/[0.1] bg-surface-2 shadow-[0_24px_60px_-28px_rgba(0,0,0,0.8)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 border-b border-white/[0.06] px-4.5 py-3.5">
              <Edit2 className="h-5 w-5" />
              <strong className="text-[15px]">编辑改编方向</strong>
              <button
                className="ml-auto text-muted transition-colors hover:text-txt"
                onClick={() => setShowEditModal(false)}
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-muted mb-1">书籍ID</label>
                  <Input
                    value={editingDirection.bookId}
                    onChange={(e) => setEditingDirection({ ...editingDirection, bookId: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-xs text-muted mb-1">世界名称</label>
                  <Input
                    value={editingDirection.worldName}
                    onChange={(e) => setEditingDirection({ ...editingDirection, worldName: e.target.value })}
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs text-muted mb-1">核心冲突</label>
                <textarea
                  value={editingDirection.coreConflict}
                  onChange={(e) => setEditingDirection({ ...editingDirection, coreConflict: e.target.value })}
                  className="w-full h-20 rounded-md border border-white/[0.1] bg-surface-3 px-3 py-2 text-sm text-txt focus:outline-none focus:ring-2 focus:ring-accent/40 resize-none"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-muted mb-1">主角名称</label>
                  <Input
                    value={editingDirection.protagonist.name}
                    onChange={(e) => setEditingDirection({ ...editingDirection, protagonist: { ...editingDirection.protagonist, name: e.target.value } })}
                  />
                </div>
                <div>
                  <label className="block text-xs text-muted mb-1">主角性格</label>
                  <Input
                    value={editingDirection.protagonist.personality}
                    onChange={(e) => setEditingDirection({ ...editingDirection, protagonist: { ...editingDirection.protagonist, personality: e.target.value } })}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-muted mb-1">主角动机</label>
                  <Input
                    value={editingDirection.protagonist.motivation}
                    onChange={(e) => setEditingDirection({ ...editingDirection, protagonist: { ...editingDirection.protagonist, motivation: e.target.value } })}
                  />
                </div>
                <div>
                  <label className="block text-xs text-muted mb-1">主角弧线</label>
                  <Input
                    value={editingDirection.protagonist.arc}
                    onChange={(e) => setEditingDirection({ ...editingDirection, protagonist: { ...editingDirection.protagonist, arc: e.target.value } })}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-muted mb-1">风格</label>
                  <Input
                    value={editingDirection.tone}
                    onChange={(e) => setEditingDirection({ ...editingDirection, tone: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-xs text-muted mb-1">读者定位</label>
                  <Input
                    value={editingDirection.readerTarget}
                    onChange={(e) => setEditingDirection({ ...editingDirection, readerTarget: e.target.value })}
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs text-muted mb-1">主题</label>
                <Input
                  value={editingDirection.theme}
                  onChange={(e) => setEditingDirection({ ...editingDirection, theme: e.target.value })}
                />
              </div>
              <div>
                <label className="block text-xs text-muted mb-1">关键转折（每行一个）</label>
                <textarea
                  value={editingDirection.keyTwists.join('\n')}
                  onChange={(e) => setEditingDirection({ ...editingDirection, keyTwists: e.target.value.split('\n').filter(Boolean) })}
                  className="w-full h-24 rounded-md border border-white/[0.1] bg-surface-3 px-3 py-2 text-sm text-txt focus:outline-none focus:ring-2 focus:ring-accent/40 resize-none"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-white/[0.06] px-4.5 py-3.5">
              <Button variant="outline" onClick={() => setShowEditModal(false)}>
                取消
              </Button>
              <Button onClick={handleSave}>保存</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}