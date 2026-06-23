import { useState, useEffect } from 'react';
import { apiGet, apiPost, apiPut, apiDelete, type AdaptDirection, type DirectionsResponse, type BatchSyncResponse, type LibraryBook } from '../lib/api';

export default function Direction() {
  const [directions, setDirections] = useState<AdaptDirection[]>([]);
  const [books, setBooks] = useState<LibraryBook[]>([]);
  const [selectedBookId, setSelectedBookId] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [filterWorldIndex, setFilterWorldIndex] = useState('');
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingDirection, setEditingDirection] = useState<AdaptDirection | null>(null);
  const [loading, setLoading] = useState(false);

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
      console.error('获取改编方向失败:', err);
    } finally {
      setLoading(false);
    }
  }

  async function fetchBooks() {
    try {
      const res = await apiGet<{ books: LibraryBook[] }>('/library');
      setBooks(res.books);
    } catch (err) {
      console.error('获取书籍列表失败:', err);
    }
  }

  async function handleBatchSync() {
    try {
      await apiPost<BatchSyncResponse>('/directions/batch');
      fetchDirections();
    } catch (err) {
      console.error('批量同步失败:', err);
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
      setShowEditModal(false);
      fetchDirections();
    } catch (err) {
      console.error('保存失败:', err);
    }
  }

  async function handleDelete(directionId: string) {
    if (!confirm('确定删除该改编方向？')) return;
    try {
      await apiDelete(`/directions/${directionId}`);
      fetchDirections();
    } catch (err) {
      console.error('删除失败:', err);
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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">改编方向管理</h1>
          <p className="text-gray-500 mt-1">管理各小说世界的改编方向建议</p>
        </div>
        <button
          onClick={handleBatchSync}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          批量同步
        </button>
      </div>

      <div className="bg-white rounded-xl shadow-sm p-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">选择书籍</label>
            <select
              value={selectedBookId}
              onChange={(e) => setSelectedBookId(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
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
            <label className="block text-sm font-medium text-gray-700 mb-1">世界编号</label>
            <select
              value={filterWorldIndex}
              onChange={(e) => setFilterWorldIndex(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            >
              <option value="">全部编号</option>
              {worldIndices.map((idx) => (
                <option key={idx} value={String(idx)}>世界 {idx}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">搜索</label>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索世界名称或核心冲突..."
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4">
        <div className="bg-white rounded-xl shadow-sm p-4">
          <div className="text-gray-500 text-sm">总改编方向</div>
          <div className="text-2xl font-bold text-gray-900">{directions.length}</div>
        </div>
        <div className="bg-white rounded-xl shadow-sm p-4">
          <div className="text-gray-500 text-sm">关联书籍</div>
          <div className="text-2xl font-bold text-blue-600">{worldIndices.length}</div>
        </div>
        <div className="bg-white rounded-xl shadow-sm p-4">
          <div className="text-gray-500 text-sm">当前筛选</div>
          <div className="text-2xl font-bold text-green-600">{filteredDirections.length}</div>
        </div>
        <div className="bg-white rounded-xl shadow-sm p-4">
          <div className="text-gray-500 text-sm">平均字数</div>
          <div className="text-2xl font-bold text-purple-600">
            {directions.length ? Math.round(directions.reduce((sum, d) => sum + d.coreConflict.length, 0) / directions.length) : 0}
          </div>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">书籍</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">世界</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">核心冲突</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">主角</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">风格</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">主题</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">创建时间</th>
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
              ) : filteredDirections.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-gray-500">
                    暂无改编方向数据
                  </td>
                </tr>
              ) : (
                filteredDirections.map((direction) => (
                  <tr key={direction.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                        {direction.bookId}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                        世界{direction.worldIndex}: {direction.worldName}
                      </span>
                    </td>
                    <td className="px-4 py-3 max-w-xs">
                      <p className="text-sm text-gray-900 truncate" title={direction.coreConflict}>
                        {direction.coreConflict}
                      </p>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="text-sm text-gray-900">{direction.protagonist.name}</div>
                      <div className="text-xs text-gray-500">{direction.protagonist.personality}</div>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="text-sm text-gray-900">{direction.tone}</div>
                      <div className="text-xs text-gray-500">{direction.readerTarget}</div>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                      {direction.theme}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                      {new Date(direction.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleEdit(direction)}
                          className="text-blue-600 hover:text-blue-900 text-sm"
                        >
                          编辑
                        </button>
                        <button
                          onClick={() => handleDelete(direction.id)}
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

      {showEditModal && editingDirection && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b">
              <h2 className="text-lg font-semibold">编辑改编方向</h2>
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
                  <label className="block text-sm font-medium text-gray-700 mb-1">书籍ID</label>
                  <input
                    type="text"
                    value={editingDirection.bookId}
                    onChange={(e) => setEditingDirection({ ...editingDirection, bookId: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">世界名称</label>
                  <input
                    type="text"
                    value={editingDirection.worldName}
                    onChange={(e) => setEditingDirection({ ...editingDirection, worldName: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">核心冲突</label>
                <textarea
                  value={editingDirection.coreConflict}
                  onChange={(e) => setEditingDirection({ ...editingDirection, coreConflict: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  rows={3}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">主角名称</label>
                  <input
                    type="text"
                    value={editingDirection.protagonist.name}
                    onChange={(e) => setEditingDirection({ ...editingDirection, protagonist: { ...editingDirection.protagonist, name: e.target.value } })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">主角性格</label>
                  <input
                    type="text"
                    value={editingDirection.protagonist.personality}
                    onChange={(e) => setEditingDirection({ ...editingDirection, protagonist: { ...editingDirection.protagonist, personality: e.target.value } })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">主角动机</label>
                  <input
                    type="text"
                    value={editingDirection.protagonist.motivation}
                    onChange={(e) => setEditingDirection({ ...editingDirection, protagonist: { ...editingDirection.protagonist, motivation: e.target.value } })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">主角弧线</label>
                  <input
                    type="text"
                    value={editingDirection.protagonist.arc}
                    onChange={(e) => setEditingDirection({ ...editingDirection, protagonist: { ...editingDirection.protagonist, arc: e.target.value } })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">风格</label>
                  <input
                    type="text"
                    value={editingDirection.tone}
                    onChange={(e) => setEditingDirection({ ...editingDirection, tone: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">读者定位</label>
                  <input
                    type="text"
                    value={editingDirection.readerTarget}
                    onChange={(e) => setEditingDirection({ ...editingDirection, readerTarget: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">主题</label>
                <input
                  type="text"
                  value={editingDirection.theme}
                  onChange={(e) => setEditingDirection({ ...editingDirection, theme: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">关键转折（每行一个）</label>
                <textarea
                  value={editingDirection.keyTwists.join('\n')}
                  onChange={(e) => setEditingDirection({ ...editingDirection, keyTwists: e.target.value.split('\n').filter(Boolean) })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  rows={4}
                />
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