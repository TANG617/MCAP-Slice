#ifndef MAINWINDOW_H
#define MAINWINDOW_H

#include <QMainWindow>
#include <QString>

#include <map>
#include <optional>
#include <set>
#include <vector>

#include <mcap/reader.hpp>
#include <mcap/writer.hpp>

class QDragEnterEvent;
class QDropEvent;
class QFileSystemModel;
class QModelIndex;
class QTableWidgetItem;

namespace Ui
{
class MainWindow;
}

class MainWindow : public QMainWindow
{
  Q_OBJECT

public:
  explicit MainWindow(QWidget* parent = nullptr);
  ~MainWindow();

  void openFilePath(const QString& filename);

protected:
  void dragEnterEvent(QDragEnterEvent* event) override;
  void dropEvent(QDropEvent* event) override;

private slots:
  void on_buttonLoad_clicked();

  void on_buttonOpenFolder_clicked();

  void on_buttonCloseFolder_clicked();

  void on_buttonResetTimeRange_clicked();

  void on_tableTopics_itemSelectionChanged();

  void on_tableTopics_itemChanged(QTableWidgetItem* item);

  void on_buttonSave_clicked();

  void on_buttonToggleSelected_clicked();

private:
  Ui::MainWindow* ui;
  struct RecordingSnapshot;

  void openFile();
  void openFileWASM();
  void openFolder();
  void openFolderPath(const QString& folder);
  void closeFolderSession();
  void refreshFolderListState();
  void beginFileLoad(const QString& filename, bool reset_selection_session);

  bool saveFile(const mcap::McapWriterOptions& options);
  bool saveFileWASM(const mcap::McapWriterOptions& options);

  static bool buildRecordingSnapshot(mcap::McapReader& reader,
                                     mcap::IReadable& source,
                                     const QString& source_name,
                                     uint64_t source_size,
                                     RecordingSnapshot& snapshot,
                                     QString& error_message);
  static bool loadRecordingSnapshotFromFile(
      const QString& filename, RecordingSnapshot& snapshot,
      QString& error_message);
  void applyRecordingSnapshot(RecordingSnapshot&& snapshot);
  void resetRecordingUi(const QString& status_text);
  void updateExportAvailability();
  void updateTopicSelectionSummary();
  std::set<std::string> selectedTopicsPresentInCurrentFile() const;
  void configureVideoPreview();
  void resetVideoPreview();
  void beginVideoIndex(mcap::ChannelId channel_id, const QString& topic);
  void requestVideoFrame(int frame_index);
  void startPendingVideoDecode();
  void updateVideoTrimRange();

  struct VideoFrameInfo
  {
    uint64_t log_time = 0;
    uint64_t publish_time = 0;
    uint32_t sequence = 0;
  };

  struct SchemaInfo
  {
    std::string name;
    std::string encoding;
    mcap::ByteArray data;
  };

  struct ChannelInfo
  {
    std::string topic;
    std::string message_encoding;
    mcap::SchemaId schema_id;
    mcap::KeyValueMap metadata;
  };

  struct RecordingSnapshot
  {
    QString source_name;
    uint64_t source_size = 0;
    std::string profile;
    uint64_t message_count = 0;
    uint32_t channel_count = 0;
    uint64_t time_start = 0;
    uint64_t time_end = 0;
    std::map<mcap::SchemaId, SchemaInfo> schemas;
    std::map<mcap::ChannelId, ChannelInfo> channels;
    std::map<mcap::ChannelId, uint64_t> channel_message_counts;
    std::vector<mcap::Metadata> metadata;
    QString metadata_error;
  };

  enum class WriteResult
  {
    Success,
    Canceled,
    Failed,
  };

  WriteResult writeMCAP(mcap::McapWriter& writer, QString& error_message);
  bool validateExportSettings();

  std::map<mcap::SchemaId, SchemaInfo> schema_by_id_;
  std::map<mcap::ChannelId, ChannelInfo> channel_by_id_;
  std::vector<mcap::Metadata> source_metadata_;
  QString source_metadata_error_;
  uint64_t source_file_size_ = 0;
  std::set<std::string> selected_topics_;

  uint64_t time_start_ = 0;
  uint64_t time_end_ = 0;
  std::string wasm_buffer_;
  std::string profile_;

  QByteArray read_buffer_;

  QString file_opened_;
  QString current_folder_;
  QFileSystemModel* file_system_model_ = nullptr;
  bool folder_model_loaded_ = false;
  quint64 file_load_generation_ = 0;
  bool populating_topics_ = false;
  std::vector<VideoFrameInfo> video_frames_;
  mcap::ChannelId active_video_channel_ = 0;
  QString active_video_topic_;
  quint64 video_generation_ = 0;
  bool video_decode_in_flight_ = false;
  int pending_video_frame_index_ = -1;
};

#endif   // MAINWINDOW_H
