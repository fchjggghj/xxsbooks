import { useState, useEffect } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/useToast';
import { apiGet, apiPost, apiPut, apiDelete, type OutlinePoolItem, type PoolItemsResponse, type GenresResponse } from '../lib/api';
import { Search, RefreshCw, Edit2, Trash2, X, BookOpen, Star, Tag, BarChart3 } from 'lucide-react';

export default function Pool() {
  const [items, setItems] = useState<OutlinePoolItem[]>([]);
  const [genres, setGenres] = useState<string[]>([]);
  const [selectedGenre, setSelectedGenre] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingItem, setEditingItem] = useState<OutlinePoolItem | null>(null);
  const [loading, setLoading] = useState(false);
  const toast = useToast();

  useEffect(() => {
    fetchItems();
    fetchGenres();
  }, []);

  async function fetchItems() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (selectedGenre) params.set('genre', selectedGenre);
      const res = await apiGet<PoolItemsResponse>(`/pool?${params.toString()}`);
      setItems(res.items || []);
    } catch (err) {
      toast.error(String(err));
    } finally {
      setLoading(false);
    }
  }

  async function fetchGenres() {
    try {
      const res = await apiGet<GenresResponse>('/pool/genres');
      setGenres(res.genres || []);
    } catch (err) {
      toast.error(String(err));
    }
  }

  async function handleBatchSync() {
    try {
      await apiPost<{ count: number }>('/pool/batch');
      toast.success('批量同步完成');
      fetchItems();
      fetchGenres();
    } catch (err) {
      toast.error(String(err));
    }
  }

  async function handleEdit(item: OutlinePoolItem) {
    setEditingItem(item);
    setShowEditModal(true);
  }

  async function handleSave() {
    if (!editingItem) return;
    try {
      await apiPut<OutlinePoolItem>(`/pool/${editingItem.id}`, editingItem);
      toast.success('保存成功');
      setShowEditModal(false);
      fetchItems();
      fetchGenres();
    } catch (err) {
      toast.error(String(err));
    }
  }

  async function handleDelete(itemId: string) {
    if (!confirm('确定删除该大纲池项？')) return;
    try {
      await apiDelete(`/pool/${itemId}`);
      toast.success('删除成功');
      fetchItems();
      fetchGenres();
    } catch (err) {
      toast.error(String(err));
    }
  }

  const filteredItems = items.filter((item) => {
    const matchQuery = !searchQuery ||
      item.outlineName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.genre.toLowerCase().includes(searchQuery.toLowerCase());
    const matchGenre = !selectedGenre || item.genre === selectedGenre;
    return matchQuery && matchGenre;
  });

  const qualityColor = (quality: number) => {
    if (quality >= 5) return 'bg-ok/15 text-ok';
    if (quality >= 4) return 'bg-warn/15 text-warn';
    return 'bg-fail/15 text-fail';
  };

  const qualityLabel = (quality: number) => {
    if (quality >= 5) return '优质';
    if (quality >= 4) return '良好';
    if (quality >= 3) return '一般';
    return '待优化';
  };

  const stats = {
    total: items.length,
    byGenre: items.reduce((acc, item) => {
      acc[item.genre] = (acc[item.genre] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
    avgQuality: items.length ? Math.round(items.reduce((sum, item) => sum + item.quality, 0) / items.length) : 0,
    totalWords: items.reduce((sum, item) => sum + item.wordCount, 0),
    bySource: items.reduce((acc, item) => {
      acc[item.bookId] = (acc[item.bookId] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <span className="block text-[11px] font-bold uppercase tracking-[1.6px] text-muted">Outline Pool</span>
          <h1 className="mt-0.5 text-[18px] font-bold">大纲池管理</h1>
        </div>
        <Button onClick={handleBatchSync} disabled={loading}>
          <RefreshCw className="mr-2 h-4 w-4" />
          批量同步
        </Button>
      </div>

      <Card className="p-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-muted mb-1.5">选择题材</label>
            <select
              value={selectedGenre}
              onChange={(e) => setSelectedGenre(e.target.value)}
              className="w-full h-9 rounded-md border border-white/[0.1] bg-surface-2 px-3 text-sm text-txt focus:outline-none focus:ring-2 focus:ring-accent/40"
            >
              <option value="">全部题材</option>
              {genres.map((genre) => (
                <option key={genre} value={genre}>
                  {genre} ({stats.byGenre[genre] || 0})
                </option>
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
                placeholder="搜索大纲名称或题材..."
                className="pl-9"
              />
            </div>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="p-3 border-glow">
          <div className="flex items-center gap-2 mb-1">
            <BarChart3 className="h-4 w-4 text-accent-2" />
            <span className="text-xs text-muted">总大纲数</span>
          </div>
          <div className="text-2xl font-bold text-gradient">{stats.total}</div>
        </Card>
        <Card className="p-3">
          <div className="flex items-center gap-2 mb-1">
            <Tag className="h-4 w-4 text-cyan" />
            <span className="text-xs text-muted">题材数量</span>
          </div>
          <div className="text-2xl font-bold text-cyan">{genres.length}</div>
        </Card>
        <Card className="p-3">
          <div className="flex items-center gap-2 mb-1">
            <BookOpen className="h-4 w-4 text-ok" />
            <span className="text-xs text-muted">总字数</span>
          </div>
          <div className="text-2xl font-bold text-ok">{stats.totalWords}</div>
        </Card>
        <Card className="p-3">
          <div className="flex items-center gap-2 mb-1">
            <Star className="h-4 w-4 text-warn" />
            <span className="text-xs text-muted">平均质量</span>
          </div>
          <div className={`text-2xl font-bold ${qualityColor(stats.avgQuality)}`}>
            {stats.avgQuality}/5
          </div>
        </Card>
      </div>

      <Card className="p-4">
        <div className="flex flex-wrap gap-2">
          <span className="text-sm font-medium text-muted">来源书籍：</span>
          {Object.entries(stats.bySource).map(([bookId, count]) => (
            <Badge key={bookId} variant="outline" className="text-[11px]">
              {bookId}: {count}
            </Badge>
          ))}
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="overflow-auto rounded-2xl">
          <table className="w-full min-w-[720px] border-collapse text-[13px]">
            <thead>
              <tr>
                <th className="sticky top-0 z-[2] border-b border-white/[0.06] bg-surface-2/95 px-3 py-2.5 text-left text-xs font-bold tracking-tight text-muted backdrop-blur-sm">
                  大纲名称
                </th>
                <th className="sticky top-0 z-[2] border-b border-white/[0.06] bg-surface-2/95 px-3 py-2.5 text-left text-xs font-bold tracking-tight text-muted backdrop-blur-sm">
                  题材
                </th>
                <th className="sticky top-0 z-[2] border-b border-white/[0.06] bg-surface-2/95 px-3 py-2.5 text-left text-xs font-bold tracking-tight text-muted backdrop-blur-sm">
                  来源
                </th>
                <th className="sticky top-0 z-[2] border-b border-white/[0.06] bg-surface-2/95 px-3 py-2.5 text-left text-xs font-bold tracking-tight text-muted backdrop-blur-sm">
                  字数
                </th>
                <th className="sticky top-0 z-[2] border-b border-white/[0.06] bg-surface-2/95 px-3 py-2.5 text-left text-xs font-bold tracking-tight text-muted backdrop-blur-sm">
                  质量
                </th>
                <th className="sticky top-0 z-[2] border-b border-white/[0.06] bg-surface-2/95 px-3 py-2.5 text-left text-xs font-bold tracking-tight text-muted backdrop-blur-sm">
                  状态
                </th>
                <th className="sticky top-0 z-[2] border-b border-white/[0.06] bg-surface-2/95 px-3 py-2.5 text-left text-xs font-bold tracking-tight text-muted backdrop-blur-sm">
                  添加时间
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
              ) : filteredItems.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-5 text-center text-muted">
                    暂无大纲池数据
                  </td>
                </tr>
              ) : (
                filteredItems.map((item) => (
                  <tr
                    key={item.id}
                    className="border-b border-white/[0.05] transition-colors hover:bg-surface-3/60"
                  >
                    <td className="px-3 py-2.5">
                      <span className="text-sm font-medium text-txt">{item.outlineName}</span>
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge className="bg-accent/15 text-accent-2">
                        {item.genre}
                      </Badge>
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge variant="outline" className="font-mono">
                        {item.bookId}
                      </Badge>
                    </td>
                    <td className="px-3 py-2.5 text-sm text-muted tabular-nums">
                      {item.wordCount} 字
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge className={qualityColor(item.quality)}>
                        {qualityLabel(item.quality)} ({item.quality}/5)
                      </Badge>
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge className={item.adapted ? 'bg-ok/15 text-ok' : 'bg-surface-3 text-muted'}>
                        {item.adapted ? '已改编' : '待改编'}
                      </Badge>
                    </td>
                    <td className="px-3 py-2.5 text-sm text-muted">
                      {new Date(item.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => handleEdit(item)}
                          className="rounded p-1 text-muted transition-colors hover:text-txt"
                          title="编辑"
                        >
                          <Edit2 className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(item.id)}
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

      {showEditModal && editingItem && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-5 backdrop-blur-md"
          onClick={() => setShowEditModal(false)}
        >
          <div
            className="flex w-[min(600px,94vw)] flex-col rounded-2xl border border-white/[0.1] bg-surface-2 shadow-[0_24px_60px_-28px_rgba(0,0,0,0.8)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 border-b border-white/[0.06] px-4.5 py-3.5">
              <Edit2 className="h-5 w-5" />
              <strong className="text-[15px]">编辑大纲池项</strong>
              <button
                className="ml-auto text-muted transition-colors hover:text-txt"
                onClick={() => setShowEditModal(false)}
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-muted mb-1">大纲名称</label>
                  <Input
                    value={editingItem.outlineName}
                    onChange={(e) => setEditingItem({ ...editingItem, outlineName: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-xs text-muted mb-1">来源书籍ID</label>
                  <Input
                    value={editingItem.bookId}
                    onChange={(e) => setEditingItem({ ...editingItem, bookId: e.target.value })}
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs text-muted mb-1">题材</label>
                <select
                  value={editingItem.genre}
                  onChange={(e) => setEditingItem({ ...editingItem, genre: e.target.value })}
                  className="w-full h-9 rounded-md border border-white/[0.1] bg-surface-3 px-3 text-sm text-txt focus:outline-none focus:ring-2 focus:ring-accent/40"
                >
                  {genres.map((genre) => (
                    <option key={genre} value={genre}>{genre}</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-muted mb-1">质量评分 (1-5)</label>
                  <Input
                    type="number"
                    min={1}
                    max={5}
                    value={editingItem.quality}
                    onChange={(e) => setEditingItem({ ...editingItem, quality: Number(e.target.value) })}
                  />
                </div>
                <div>
                  <label className="block text-xs text-muted mb-1">字数</label>
                  <Input
                    type="number"
                    value={editingItem.wordCount}
                    onChange={(e) => setEditingItem({ ...editingItem, wordCount: Number(e.target.value) })}
                  />
                </div>
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