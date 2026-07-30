#include "mainwindow.h"

#include <QApplication>
#include <QEvent>
#include <QFileOpenEvent>
#include <QFileInfo>
#include <QIcon>
#include <QSettings>

class McapSliceApplication : public QApplication
{
public:
  using QApplication::QApplication;

  void setMainWindow(MainWindow* window)
  {
    window_ = window;
    if (!pending_file_.isEmpty())
    {
      window_->openFilePath(pending_file_);
      pending_file_.clear();
    }
  }

protected:
  bool event(QEvent* event) override
  {
    if (event->type() == QEvent::FileOpen)
    {
      const auto* file_event = static_cast<QFileOpenEvent*>(event);
      if (window_)
      {
        window_->openFilePath(file_event->file());
      }
      else
      {
        pending_file_ = file_event->file();
      }
      return true;
    }
    return QApplication::event(event);
  }

private:
  MainWindow* window_ = nullptr;
  QString pending_file_;
};

int main(int argc, char* argv[])
{
  McapSliceApplication app(argc, argv);

  QCoreApplication::setOrganizationName("TANG617");
  QCoreApplication::setOrganizationDomain("github.com/TANG617");
  QCoreApplication::setApplicationName("MCAP Slice");
  QCoreApplication::setApplicationVersion(MCAP_SLICE_VERSION);
  QSettings::setDefaultFormat(QSettings::IniFormat);
  app.setWindowIcon(QIcon(":/mcap_slice.png"));

  MainWindow w;
  app.setMainWindow(&w);
  if (argc > 1)
  {
    const QString candidate = QString::fromLocal8Bit(argv[1]);
    if (QFileInfo::exists(candidate))
    {
      w.openFilePath(candidate);
    }
  }
  w.show();
  return app.exec();
}
