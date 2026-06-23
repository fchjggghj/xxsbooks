import { useState, useEffect } from 'react';
import { apiGet, apiPost, apiPut, apiDelete, type OutlinePoolItem, type PoolItemsResponse, type GenresResponse } from '../lib/api';

export default function Pool() {
  const [items, setItems] = useState<OutlinePoolItem[]>([]);
  const [genres, setGenres] = useState<string[]>([]);
  const [selectedGenre, setSelectedGenre] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingItem, setEditingItem] = useState<OutlinePoolItem | null>(null);
  const [loading, setLoading] = useState(false);

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
      console.error('获取大纲池失败:', err);
    } finally {
      setLoading(false);
    }
  }

  async function fetchGenres() {
    try {
      const res = await apiGet<GenresResponse>('/pool/genres');
      setGenres(res.genres || []);
    } catch (err) {
      console.error('获取题材列表失败:', err);
    }
  }

  async function handleBatchSync() {
    try {
      await apiPost<{ count: number }>('/pool/batch');
      fetchItems();
      fetchGenres();
    } catch (err) {
      console.error('批量同步失败:', err);
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
      setShowEditModal(false);
      fetchItems();
      fetchGenres();
    } catch (err) {
      console.error('保存失败:', err);
    }
  }

  async function handleDelete(itemId: string) {
    if (!confirm('确定删除该大纲池项？')) return;
    try {
      await apiDelete(`/pool/${itemId}`);
      fetchItems();
      fetchGenres();
    } catch (err) {
      console.error('删除失败:', err);
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
    if (quality >= 5) return 'bg-green-100 text-green-800';
    if (quality >= 4) return 'bg-yellow-100 text-yellow-800';
    return 'bg-red-100 text-red-800';
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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">大纲池管理</h1>
          <p className="text-gray-500 mt-1">管理改编后的大纲，按题材分类存储</p>
        </div>
        <button
          onClick={handleBatchSync}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          批量同步
        </button>
      </div>

      <div className="bg-white rounded-xl shadow-sm p-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">选择题材</label>
            <select
              value={selectedGenre}
              onChange={(e) => setSelectedGenre(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
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
            <label className="block text-sm font-medium text-gray-700 mb-1">搜索</label>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索大纲名称或题材..."
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl shadow-sm p-4">
          <div className="text-gray-500 text-sm">总大纲数</div>
          <div className="text-2xl font-bold text-gray-900">{stats.total}</div>
        </div>
        <div className="bg-white rounded-xl shadow-sm p-4">
          <div className="text-gray-500 text-sm">题材数量</div>
          <div className="text-2xl font-bold text-blue-600">{genres.length}</div>
        </div>
        <div className="bg-white rounded-xl shadow-sm p-4">
          <div className="text-gray-500 text-sm">总字数</div>
          <div className="text-2xl font-bold text-green-600">{stats.totalWords}</div>
        </div>
        <div className="bg-white rounded-xl shadow-sm p-4">
          <div className="text-gray-500 text-sm">平均质量</div>
          <div className={`text-2xl font-bold ${qualityColor(stats.avgQuality)} inline-block px-2 rounded`}>
            {stats.avgQuality}/5
          </div>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm p-4">
        <div className="flex flex-wrap gap-2">
          <span className="text-sm font-medium text-gray-700">来源书籍：</span>
          {Object.entries(stats.bySource).map(([bookId, count]) => (
            <span key={bookId} className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-purple-100 text-purple-800">
              {bookId}: {count}
            </span>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">大纲名称</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">题材</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">来源</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">字数</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">质量</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">状态</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">添加时间</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">操作</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {loading ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-gray-500">
                    加载中...
                  </td>
                </tr>
              ) : filteredItems.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-gray-500">
                    暂无大纲池数据
                  </td>
                </tr>
              ) : (
                filteredItems.map((item) => (
                  <tr key={item.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className="text-sm font-medium text-gray-900">{item.outlineName}</span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                        {item.genre}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                        {item.bookId}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                      {item.wordCount} 字
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${qualityColor(item.quality)}`}>
                        {qualityLabel(item.quality)} ({item.quality}/5)
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${item.adapted ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}`}>
                        {item.adapted ? '已改编' : '待改编'}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                      {new Date(item.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleEdit(item)}
                          className="text-blue-600 hover:text-blue-900 text-sm"
                        >
                          编辑
                        </button>
                        <button
                          onClick={() => handleDelete(item.id)}
                          className="text-red-600 hover:text-red-900 text-sm"
                        >
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showEditModal && editingItem && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b">
              <h2 className="text-lg font-semibold">编辑大纲池项</h2>
              <button
                onClick={() => setShowEditModal(false)}
                className="text-gray-500 hover:text-gray-700"
              >
                ✕
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">大纲名称</label>
                  <input
                    type="text"
                    value={editingItem.outlineName}
                    onChange={(e) => setEditingItem({ ...editingItem, outlineName: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">来源书籍ID</label>
                  <input
                    type="text"
                    value={editingItem.bookId}
                    onChange={(e) => setEditingItem({ ...editingItem, bookId: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">题材</label>
                <select
                  value={editingItem.genre}
                  onChange={(e) => setEditingItem({ ...editingItem, genre: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                >
                  {genres.map((genre) => (
                    <option key={genre} value={genre}>{genre}</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">质量评分 (1-5)</label>
                  <input
                    type="number"
                    min={1}
                    max={5}
                    value={editingItem.quality}
                    onChange={(e) => setEditingItem({ ...editingItem, quality: Number(e.target.value) })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">字数</label>
                  <input
                    type="number"
                    value={editingItem.wordCount}
                    onChange={(e) => setEditingItem({ ...editingItem, wordCount: Number(e.target.value) })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  />
                </div>
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t">
              <button
                onClick={() => setShowEditModal(false)}
                className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200"
              >
                取消
              </button>
              <button
                onClick={handleSave}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}